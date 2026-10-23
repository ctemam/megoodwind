import csv
from collections import defaultdict

csv_path = '/Users/sanghyeonkwon/Downloads/arbitrage-scan-data-1765996254807.csv'

spreads = []
eth_prices = []
opportunities = 0
total_scans = 0
reject_reasons = defaultdict(int)
pair_spreads = defaultdict(list)
max_spread_entry = None
max_spread = 0
time_spreads = []

with open(csv_path, 'r') as f:
    reader = csv.reader(f)
    for row in reader:
        if len(row) < 29:
            continue
        
        total_scans += 1
        
        # Column indices:
        # [0]=timestamp, [1]=scanNum, [2]=pair, [3]=spread, [4]=hasOpp, [5]=rejectReason
        # [27]=ethPriceUsd, [28]=gasGwei
        timestamp = row[0]
        pair = row[2]
        spread = float(row[3])
        has_opp = int(row[4])
        reject_reason = row[5].strip() if row[5] else ''
        eth_price = float(row[27])
        
        spreads.append(spread)
        eth_prices.append(eth_price)
        pair_spreads[pair].append(spread)
        time_spreads.append((timestamp, spread, pair, reject_reason, eth_price))
        
        if has_opp == 1:
            opportunities += 1
        
        if reject_reason:
            reject_reasons[reject_reason] += 1
        
        if spread > max_spread:
            max_spread = spread
            max_spread_entry = row

# Statistics
avg_spread = sum(spreads) / len(spreads)
max_spread_val = max(spreads)
min_spread_val = min(spreads)
sorted_spreads = sorted(spreads)
median_spread = sorted_spreads[len(sorted_spreads)//2]

avg_eth = sum(eth_prices) / len(eth_prices)
max_eth = max(eth_prices)
min_eth = min(eth_prices)

print("=" * 80)
print("📊 4시간 스캔 데이터 최종 분석")
print("=" * 80)
print(f"\n⏱️  시간 범위: 14:07 - 18:30 KST (~4시간)")
print(f"   전체 레코드: {total_scans:,}개")
print(f"   스캔 횟수: ~{total_scans // 3}회 (페어당 3개씩)")
print(f"   ✅ 발견된 기회: {opportunities}개")
print(f"   ❌ 결론: **4시간 동안 단 1건의 기회도 발견 안 됨**")

print(f"\n💹 스프레드 통계:")
print(f"   평균:   {avg_spread:.4f}%")
print(f"   중앙값: {median_spread:.4f}%")
print(f"   최소:   {min_spread_val:.4f}%")
print(f"   최대:   {max_spread_val:.4f}%  👈 이것도 리젝트됨")

print(f"\n🏆 최고 스프레드 케이스 (그래도 실패):")
if max_spread_entry:
    print(f"   페어:       {max_spread_entry[2]}")
    print(f"   스프레드:   {max_spread_entry[3]}%")
    print(f"   시각:       {max_spread_entry[0]}")
    print(f"   Buy DEX:    {max_spread_entry[18]} @ ${float(max_spread_entry[19]):.2f}")
    print(f"   Sell DEX:   {max_spread_entry[20]} @ 1 WETH = {float(max_spread_entry[21]):.6f} Token")
    print(f"   기회 여부:  {'YES ✅' if max_spread_entry[4] == '1' else 'NO ❌'}")
    print(f"   리젝트 사유: {max_spread_entry[5] if max_spread_entry[5] else '(스프레드 너무 작음)'}")
    print(f"   ETH 가격:   ${float(max_spread_entry[27]):.2f}")

print(f"\n🔢 페어별 스프레드:")
for pair, pair_spread_list in sorted(pair_spreads.items()):
    avg = sum(pair_spread_list) / len(pair_spread_list)
    max_val = max(pair_spread_list)
    min_val = min(pair_spread_list)
    print(f"   {pair:12s}  평균 {avg:.4f}%  |  최소 {min_val:.4f}%  |  최대 {max_val:.4f}%")

print(f"\n💎 ETH 가격 통계 (Chainlink):")
print(f"   평균:       ${avg_eth:.2f}")
print(f"   범위:       ${min_eth:.2f} ~ ${max_eth:.2f}")
if min_eth > 0:
    volatility_pct = ((max_eth - min_eth) / min_eth * 100)
    print(f"   변동폭:     ${max_eth - min_eth:.2f} ({volatility_pct:.2f}%)")
print(f"   👉 나스닥 개장 후 ETH 가격 올랐다가 다시 하락")

print(f"\n❌ 리젝트 사유 분석:")
if reject_reasons:
    for reason, count in sorted(reject_reasons.items(), key=lambda x: -x[1]):
        pct = count / total_scans * 100
        print(f"   '{reason[:45]:45s}' {count:4d}건 ({pct:5.1f}%)")
else:
    total_no_reason = total_scans - sum(reject_reasons.values())
    print(f"   (명시적 리젝트 없음 = 스프레드가 0.17% minSpreadPercent 기준 미달)")
    print(f"   전체 {total_scans}건 중 명시적 리젝트: {sum(reject_reasons.values())}건")

# Spread 분포
spread_ranges = [
    ('< 0.1%', 0, 0.1),
    ('0.1~0.2%', 0.1, 0.2),
    ('0.2~0.3%', 0.2, 0.3),
    ('0.3~0.4%', 0.3, 0.4),
    ('0.4~0.5%', 0.4, 0.5),
    ('>= 0.5%', 0.5, 999),
]
counts = {label: 0 for label, _, _ in spread_ranges}
for s in spreads:
    for label, low, high in spread_ranges:
        if low <= s < high:
            counts[label] += 1
            break

print(f"\n📊 스프레드 분포 (총 {len(spreads)}건):")
for label, _, _ in spread_ranges:
    count = counts[label]
    pct = (count / len(spreads) * 100) if spreads else 0
    bar = '█' * int(pct / 2)
    print(f"   {label:10s} {count:4d}건 ({pct:5.1f}%) {bar}")

print(f"\n🔝 Top 10 최고 스프레드:")
sorted_time_spreads = sorted(time_spreads, key=lambda x: x[1], reverse=True)[:10]
for i, (ts, spread, pair, reject, eth) in enumerate(sorted_time_spreads, 1):
    time_str = ts.split('T')[1][:8]
    reject_str = reject if reject else '(너무 작음)'
    print(f"   {i:2d}. {pair:10s} {spread:6.4f}% @ {time_str} ETH=${eth:.2f} - {reject_str[:30]}")

print("\n" + "=" * 80)
print("💡 핵심 결론")
print("=" * 80)
print("1. 기회 발견: 0건 (4시간 내내 없음)")
print("2. 평균 스프레드: 0.163% (minSpreadPercent 0.17% 근처지만 대부분 미달)")
print("3. 최대 스프레드: 0.5166% (WETH/USDT) → 그래도 'Not profitable after fees' 리젝트")
print("4. ETH 가격: $2,836 ~ $3,014 변동 (6.2% 범위)")
print("5. 리젝트 이유: 거의 대부분 '스프레드 너무 작음' 또는 'Not profitable after fees'")
print("\n➡️  현재 전략(minProfit=$5, minSpread=0.17%)으로는 하드햇 포크에서 기회 못 잡음")
print("➡️  실전(메인넷 라이브) 전략 튜닝 필요 또는 더 긴 시간 모니터링 필요")
print("=" * 80)
