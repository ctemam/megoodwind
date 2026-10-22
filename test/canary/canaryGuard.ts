import { ethers } from 'ethers';

/**
 * Canary hard-safety gate — refuses to run unless the execution RPC is
 * local AND the forked chain is NOT mainnet. Every check aborts the
 * process, never downgrades to a warning.
 */

export function assertLocalRpc(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`CANARY_ABORT: unparseable rpc url ${url}`);
  }
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(host)) {
    throw new Error(`CANARY_ABORT: rpc host ${host} is not loopback — refusing to arm a remote endpoint`);
  }
}

export async function assertNotMainnet(rpcUrl: string): Promise<number> {
  const p = new ethers.JsonRpcProvider(rpcUrl);
  const net = await p.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === 1) {
    throw new Error(`CANARY_ABORT: chainId 1 detected — the canary must never run on mainnet`);
  }
  return chainId;
}

export function assertThrowawayKey(privKey: string, knownProductionAddresses: string[]): void {
  const addr = ethers.computeAddress(privKey.startsWith('0x') ? privKey : `0x${privKey}`);
  if (knownProductionAddresses.some((a) => a.toLowerCase() === addr.toLowerCase())) {
    throw new Error(`CANARY_ABORT: supplied key controls a production address — throwaway keys only`);
  }
}

/** Self-test: the gate must abort on a non-local RPC. */
export function _selfTest(): void {
  let aborted = false;
  try {
    assertLocalRpc('https://mainnet.infura.io/v3/deadbeef');
  } catch (e) {
    aborted = String((e as Error).message).includes('CANARY_ABORT');
  }
  if (!aborted) throw new Error('SELFTEST FAIL: non-local rpc did not abort');
  aborted = false;
  try {
    assertLocalRpc('http://192.168.1.50:8545');
  } catch (e) {
    aborted = String((e as Error).message).includes('CANARY_ABORT');
  }
  if (!aborted) throw new Error('SELFTEST FAIL: LAN rpc did not abort');
  assertLocalRpc('http://127.0.0.1:8545'); // must NOT throw
  assertLocalRpc('http://localhost:8546'); // must NOT throw
  console.log('PASS canaryGuard: remote rpc aborts, loopback allowed');
}

if (process.argv[1] && process.argv[1].endsWith('canaryGuard.ts')) _selfTest();
