import csv
from collections import defaultdict
from datetime import datetime

csv_path = '/Users/sanghyeonkwon/Downloads/arbitrage-scan-data-1766137009534.csv'

spreads = []
eth_prices = []
gas_prices = []
opportunities = 0
total_scans = 0
reject_reasons = defaultdict(int)
pair_spreads = defaultdict(list)
max_spread_entry = None
max_spread = 0
time_spreads = []
high_spread_cases = []  # 0.17% 이상인데도 리젝트된 케이스

# CSV 컬럼 인덱스 확인
# [0]=timestamp, [1]=scanNum, [2]=pair, [3]=spreadPercent, [4]=hasOpportunity, [5]=rejectReason
# [27]=ethPriceUsd, [28]=gasGwei

with open(csv_path, 'r') as f:
    reader = csv.reader(f)
    header = next(reader)  # Skip header
    
    for row in reader:
        if len(row) < 29:
            continue
        
        total_scans += 1
        
        try:
            timestamp = row[0]
            scan_num = int(row[1]) if row[1] else 0
            pair = row[2]
            spread = float(row[3]) if row[3] else 0.0
            has_opp = int(row[4]) if row[4] else 0
            reject_reason = row[5].strip() if len(row) > 5 and row[5] else ''
            eth_price = float(row[27]) if len(row) > 27 and row[27] else 0.0
            gas_gwei = float(row[28]) if len(row) > 28 and row[28] else 0.0
            
            spreads.append(spread)
            eth_prices.append(eth_price)
            gas_prices.append(gas_gwei)
            pair_spreads[pair].append(spread)
            time_spreads.append((timestamp, spread, pair, reject_reason, eth_price, gas_gwei, has_opp))
            
            if has_opp == 1:
                opportunities += 1
            
            if reject_reason:
                reject_reasons[reject_reason] += 1
            
            # 0.17% 이상인데도 기회가 아닌 케이스 추적
            if spread >= 0.17 and has_opp == 0:
                high_spread_cases.append({
                    'timestamp': timestamp,
                    'pair': pair,
                    'spread': spread,
                    'reject_reason': reject_reason,
                    'eth_price': eth_price,
                    'gas_gwei': gas_gwei
                })
            
            if spread > max_spread:
                max_spread = spread
                max_spread_entry = row
        except (ValueError, IndexError) as e:
            continue

# Statistics
if spreads:
    avg_spread = sum(spreads) / len(spreads)
    max_spread_val = max(spreads)
    min_spread_val = min(spreads)
    sorted_spreads = sorted(spreads)
    median_spread = sorted_spreads[len(sorted_spreads)//2]
else:
    avg_spread = max_spread_val = min_spread_val = median_spread = 0

if eth_prices:
    avg_eth = sum(eth_prices) / len(eth_prices)
    max_eth = max(eth_prices)
    min_eth = min(eth_prices)
else:
    avg_eth = max_eth = min_eth = 0

if gas_prices:
    avg_gas = sum(gas_prices) / len(gas_prices)
    max_gas = max(gas_prices)
    min_gas = min(gas_prices)
else:
    avg_gas = max_gas = min_gas = 0

# 시간 범위 계산
if time_spreads:
    first_time = time_spreads[0][0]
    last_time = time_spreads[-1][0]
    try:
        first_dt = datetime.fromisoformat(first_time.replace('Z', '+00:00'))
        last_dt = datetime.fromisoformat(last_time.replace('Z', '+00:00'))
        duration = last_dt - first_dt
        hours = duration.total_seconds() / 3600
    except:
        hours = 0
else:
    hours = 0

print("=" * 80)
print("📊 CSV 데이터 분석 리포트")
print("=" * 80)
print(f"\n⏱️  시간 범위: {first_time if time_spreads else 'N/A'} ~ {last_time if time_spreads else 'N/A'}")
print(f"   전체 레코드: {total_scans:,}개")
print(f"   스캔 횟수: ~{total_scans // 3}회 (페어당 3개씩)")
print(f"   모니터링 시간: ~{hours:.1f}시간")
print(f"   ✅ 발견된 기회: {opportunities}개")
print(f"   ❌ 기회 발견률: {(opportunities/total_scans*100) if total_scans > 0 else 0:.2f}%")

print(f"\n💹 스프레드 통계:")
print(f"   평균:   {avg_spread:.4f}%")
print(f"   중앙값: {median_spread:.4f}%")
print(f"   최소:   {min_spread_val:.4f}%")
print(f"   최대:   {max_spread_val:.4f}%")

print(f"\n💎 ETH 가격 통계:")
print(f"   평균:       ${avg_eth:.2f}")
print(f"   범위:       ${min_eth:.2f} ~ ${max_eth:.2f}")
if min_eth > 0:
    volatility_pct = ((max_eth - min_eth) / min_eth * 100)
    print(f"   변동폭:     ${max_eth - min_eth:.2f} ({volatility_pct:.2f}%)")

print(f"\n⛽ 가스 가격 통계:")
print(f"   평균:       {avg_gas:.2f} Gwei")
print(f"   범위:       {min_gas:.2f} ~ {max_gas:.2f} Gwei")

print(f"\n🏆 최고 스프레드 케이스:")
if max_spread_entry:
    print(f"   페어:       {max_spread_entry[2]}")
    print(f"   스프레드:   {max_spread_entry[3]}%")
    print(f"   시각:       {max_spread_entry[0]}")
    print(f"   기회 여부:  {'YES ✅' if max_spread_entry[4] == '1' else 'NO ❌'}")
    print(f"   리젝트 사유: {max_spread_entry[5] if len(max_spread_entry) > 5 and max_spread_entry[5] else '(스프레드 너무 작음)'}")
    print(f"   ETH 가격:   ${float(max_spread_entry[27]):.2f}")
    print(f"   가스:       {float(max_spread_entry[28]):.2f} Gwei")

print(f"\n🔢 페어별 스프레드:")
for pair, pair_spread_list in sorted(pair_spreads.items()):
    avg = sum(pair_spread_list) / len(pair_spread_list)
    max_val = max(pair_spread_list)
    min_val = min(pair_spread_list)
    count = len(pair_spread_list)
    print(f"   {pair:12s}  평균 {avg:.4f}%  |  최소 {min_val:.4f}%  |  최대 {max_val:.4f}%  |  {count}건")

print(f"\n❌ 리젝트 사유 분석:")
if reject_reasons:
    for reason, count in sorted(reject_reasons.items(), key=lambda x: -x[1]):
        pct = count / total_scans * 100
        print(f"   '{reason[:50]:50s}' {count:4d}건 ({pct:5.1f}%)")
else:
    total_no_reason = total_scans - sum(reject_reasons.values())
    print(f"   (명시적 리젝트 없음 = 스프레드가 0.17% minSpreadPercent 기준 미달)")
    print(f"   전체 {total_scans}건 중 명시적 리젝트: {sum(reject_reasons.values())}건")
    print(f"   스프레드 미달: {total_no_reason}건 ({total_no_reason/total_scans*100:.1f}%)")

# Spread 분포
spread_ranges = [
    ('< 0.1%', 0, 0.1),
    ('0.1~0.17%', 0.1, 0.17),
    ('0.17~0.2%', 0.17, 0.2),
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
    print(f"   {label:12s} {count:4d}건 ({pct:5.1f}%) {bar}")

print(f"\n🔝 Top 20 최고 스프레드:")
sorted_time_spreads = sorted(time_spreads, key=lambda x: x[1], reverse=True)[:20]
for i, (ts, spread, pair, reject, eth, gas, has_opp) in enumerate(sorted_time_spreads, 1):
    time_str = ts.split('T')[1][:8] if 'T' in ts else ts[:8]
    reject_str = reject if reject else '(스프레드 미달)'
    opp_str = '✅' if has_opp == 1 else '❌'
    print(f"   {i:2d}. {opp_str} {pair:10s} {spread:6.4f}% @ {time_str} ETH=${eth:.2f} Gas={gas:.2f}Gwei - {reject_str[:35]}")

# 0.17% 이상인데도 리젝트된 케이스 분석
if high_spread_cases:
    print(f"\n⚠️  0.17% 이상인데도 리젝트된 케이스: {len(high_spread_cases)}건")
    print(f"   (이것들이 로직 문제일 가능성이 높음)")
    sorted_high = sorted(high_spread_cases, key=lambda x: x['spread'], reverse=True)[:10]
    for i, case in enumerate(sorted_high, 1):
        time_str = case['timestamp'].split('T')[1][:8] if 'T' in case['timestamp'] else case['timestamp'][:8]
        print(f"   {i:2d}. {case['pair']:10s} {case['spread']:6.4f}% @ {time_str} ETH=${case['eth_price']:.2f} Gas={case['gas_gwei']:.2f}Gwei")
        print(f"       리젝트: {case['reject_reason'] if case['reject_reason'] else '(명시적 리젝트 없음)'}")

print("\n" + "=" * 80)
print("💡 핵심 결론")
print("=" * 80)
if opportunities == 0:
    print("❌ 기회 발견: 0건")
    print(f"   평균 스프레드: {avg_spread:.4f}% (minSpreadPercent 0.17% 기준)")
    if high_spread_cases:
        print(f"   ⚠️  {len(high_spread_cases)}건이 0.17% 이상인데도 리젝트됨 → 로직 점검 필요!")
    else:
        print(f"   → 대부분 스프레드가 0.17% 미달")
else:
    print(f"✅ 기회 발견: {opportunities}건 ({opportunities/total_scans*100:.2f}%)")

print("\n➡️  다음 단계:")
if high_spread_cases:
    print("   1. 0.17% 이상인데도 리젝트된 케이스의 로직 점검 필요")
    print("   2. fetch 오류 확인 (가격 데이터가 정확한지)")
    print("   3. 수익성 계산 로직 점검 (가스비, 수수료 계산)")
else:
    print("   1. 스프레드가 너무 작음 → minSpreadPercent 조정 고려")
    print("   2. 더 긴 시간 모니터링 필요")
    print("   3. 실전(메인넷 라이브) 환경에서 테스트")
print("=" * 80)

