use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use tracing::{debug, warn};

use crate::{Bundle, SubmitResult, SubmitTier, Submitter};

/// Consecutive over-budget or failed submissions before a venue is benched.
pub const SUBMIT_BENCH_STREAK: usize = 3;
/// Bench duration for a venue that keeps missing the submission deadline.
pub const SUBMIT_BENCH_SECS: u64 = 60;

#[derive(Default)]
struct VenueHealth {
    benched_until: Option<Instant>,
    over_budget_streak: usize,
    /// EMA of measured submission RTT; 0 = never measured.
    ema_rtt_ms: f64,
}

pub struct RoutedSubmit {
    pub venue: &'static str,
    pub tier: SubmitTier,
    pub result: Result<SubmitResult>,
    pub rtt: Duration,
}

/// Per-chain submission routing switch for the block-construction loop.
///
/// - Orders venues by measured health (EMA RTT) so the fastest private
///   builder is always primary.
/// - A venue whose submit RTT keeps exceeding the chain's submit budget
///   (or that errors) is benched for `SUBMIT_BENCH_SECS` — the same
///   failover discipline the read-RPC pool uses.
/// - `slot_budget` is the hard cutoff: once the current block slot is
///   past its construction window, fan-out is skipped entirely — a bundle
///   sent that late lands stale or not at all.
///
/// Budgets classify, they do not abort: an in-flight submission is never
/// cancelled, it just counts against the venue's health.
pub struct VenueRouter {
    venues: Vec<Box<dyn Submitter>>,
    health: Vec<Mutex<VenueHealth>>,
    submit_budget: Duration,
    slot_budget: Duration,
}

impl VenueRouter {
    pub fn new(
        venues: Vec<Box<dyn Submitter>>,
        submit_budget_ms: u64,
        slot_budget_ms: u64,
    ) -> Self {
        let health = venues.iter().map(|_| Mutex::new(VenueHealth::default())).collect();
        Self {
            venues,
            health,
            submit_budget: Duration::from_millis(submit_budget_ms),
            slot_budget: Duration::from_millis(slot_budget_ms),
        }
    }

    pub fn len(&self) -> usize {
        self.venues.len()
    }

    /// Venue indices in routing order: unbenched, fastest-EMA first.
    fn order(&self) -> Vec<usize> {
        let now = Instant::now();
        let mut routable: Vec<(f64, usize)> = Vec::with_capacity(self.venues.len());
        for (i, h) in self.health.iter().enumerate() {
            let h = h.lock().unwrap();
            if h.benched_until.is_some_and(|t| t > now) {
                continue;
            }
            routable.push((h.ema_rtt_ms, i));
        }
        // Emergency reset: every venue benched would starve the loop — take
        // the bench off the healthiest one rather than stopping submission.
        if routable.is_empty() && !self.venues.is_empty() {
            if let Some((best_i, _)) = self
                .health
                .iter()
                .enumerate()
                .map(|(i, h)| (i, h.lock().unwrap().ema_rtt_ms))
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            {
                warn!(
                    venue = self.venues[best_i].venue_name(),
                    "All submit venues benched — emergency reset on healthiest venue"
                );
                self.health[best_i].lock().unwrap().benched_until = None;
                routable.push((0.0, best_i));
            }
        }
        routable.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        routable.into_iter().map(|(_, i)| i).collect()
    }

    /// Fan the bundle out to routable venues in health order, record RTT,
    /// update per-venue health. `block_elapsed` is how far into the current
    /// slot we already are; past `slot_budget` nothing goes out.
    pub async fn submit_all(
        &self,
        bundle: &Bundle,
        use_high_ev: bool,
        block_elapsed: Duration,
    ) -> Vec<RoutedSubmit> {
        if block_elapsed >= self.slot_budget {
            warn!(
                elapsed_ms = block_elapsed.as_millis(),
                slot_budget_ms = self.slot_budget.as_millis(),
                "Slot budget exhausted — skipping submission fan-out"
            );
            return Vec::new();
        }

        let needs_bundle_ordering = bundle.victim_tx.is_some();
        let route = self.order();
        let futures: Vec<_> = route
            .iter()
            .copied()
            .filter(|&i| {
                let s = &self.venues[i];
                let t = s.tier();
                // A backrun only profits if it lands immediately after the
                // victim tx — single-tx/public/UserOp venues give no ordering
                // guarantee and would just burn gas on a state-dependent call.
                let can_carry = !needs_bundle_ordering || s.is_bundle_venue();
                can_carry
                    && (t == SubmitTier::AlwaysOn
                        || (t == SubmitTier::HighEvOnly && use_high_ev))
            })
            .map(|i| {
                let b = bundle.clone();
                let s = &self.venues[i];
                async move {
                    let start = Instant::now();
                    let result = s.submit(&b).await;
                    (i, start.elapsed(), result)
                }
            })
            .collect();

        let mut out = Vec::with_capacity(futures.len());
        for (i, rtt, result) in futures::future::join_all(futures).await {
            let over_budget = rtt > self.submit_budget;
            let ok = matches!(&result, Ok(r) if r.success);
            {
                let mut h = self.health[i].lock().unwrap();
                let rtt_ms = rtt.as_secs_f64() * 1000.0;
                h.ema_rtt_ms = if h.ema_rtt_ms == 0.0 {
                    rtt_ms
                } else {
                    h.ema_rtt_ms * 0.7 + rtt_ms * 0.3
                };
                // A paymaster merit rejection (the bundler simulated our op
                // and it reverted — e.g. the edge decayed before inclusion)
                // says this *op* lost, not that the venue is unhealthy.
                // Sponsorship rejects are free for us, so treating them as
                // venue failures benches the only submission channel while
                // candidates keep arriving. Only transport-class faults,
                // systematic blockers (quota/policy/paymaster balance), and
                // over-budget RTT count toward the bench streak.
                let merit_reject = result
                    .as_ref()
                    .err()
                    .and_then(crate::pimlico::sponsorship_reject_reason)
                    .is_some_and(|r| r == "exec_revert" || r == "rejected");
                if (!ok || over_budget) && !merit_reject {
                    h.over_budget_streak += 1;
                    if h.over_budget_streak >= SUBMIT_BENCH_STREAK {
                        h.benched_until = Some(Instant::now() + Duration::from_secs(SUBMIT_BENCH_SECS));
                        h.over_budget_streak = 0;
                        warn!(
                            venue = self.venues[i].venue_name(),
                            rtt_ms = format!("{:.1}", rtt_ms),
                            budget_ms = self.submit_budget.as_millis(),
                            "Submit venue benched for {SUBMIT_BENCH_SECS}s"
                        );
                    }
                } else {
                    h.over_budget_streak = 0;
                }
            }
            if over_budget {
                debug!(
                    venue = self.venues[i].venue_name(),
                    rtt_ms = format!("{:.1}", rtt.as_secs_f64() * 1000.0),
                    budget_ms = self.submit_budget.as_millis(),
                    "Venue over submit budget"
                );
            }
            out.push(RoutedSubmit {
                venue: self.venues[i].venue_name(),
                tier: self.venues[i].tier(),
                result,
                rtt,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pimlico::SponsorReject;

    struct RejectVenue {
        reason: &'static str,
        transient: bool,
    }

    #[async_trait::async_trait]
    impl Submitter for RejectVenue {
        fn venue_name(&self) -> &'static str {
            "test_reject"
        }
        fn tier(&self) -> SubmitTier {
            SubmitTier::AlwaysOn
        }
        async fn submit(&self, _bundle: &Bundle) -> Result<SubmitResult> {
            Err(SponsorReject {
                reason: self.reason,
                transient: self.transient,
                detail: "test".into(),
            }
            .into())
        }
    }

    fn empty_bundle() -> Bundle {
        Bundle {
            signed_txs: vec![],
            victim_tx: None,
            target_block: 0,
            chain_id: 56,
            backrun_tx: None,
            call: None,
        }
    }

    #[tokio::test]
    async fn merit_rejects_do_not_bench_venue() {
        // exec_revert = the paymaster simulated our op and it reverted on
        // its own merits (decayed edge). Free for us — the venue is fine.
        let router = VenueRouter::new(
            vec![Box::new(RejectVenue {
                reason: "exec_revert",
                transient: false,
            })],
            800,
            1_600,
        );
        for _ in 0..SUBMIT_BENCH_STREAK + 2 {
            router
                .submit_all(&empty_bundle(), false, Duration::ZERO)
                .await;
        }
        assert_eq!(router.order().len(), 1, "venue must stay routable");
    }

    #[tokio::test]
    async fn transport_rejects_bench_venue() {
        let router = VenueRouter::new(
            vec![Box::new(RejectVenue {
                reason: "transport",
                transient: true,
            })],
            800,
            1_600,
        );
        for _ in 0..SUBMIT_BENCH_STREAK {
            router
                .submit_all(&empty_bundle(), false, Duration::ZERO)
                .await;
        }
        // Benched venues are dropped from order(); with a single venue the
        // emergency-reset unbenches one on the next call to order().
        assert!(
            router
                .health
                .iter()
                .any(|h| h.lock().unwrap().benched_until.is_some())
                || router.order().is_empty(),
            "transport-class failures must bench the venue"
        );
    }
}
