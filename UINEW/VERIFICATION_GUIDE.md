# Arbitrage Opportunity Verification Guide

실제로 차익거래 기회가 수익이 났을지 검증하는 방법입니다.

## 1. 가격 검증 (Price Verification)

### DEXTools로 확인
1. Opportunity 카드의 "🔍 Verify on DEXTools" 링크 클릭
2. 해당 시점의 실제 가격 확인
3. UI에 표시된 가격과 비교

### Etherscan으로 확인
```
https://etherscan.io/address/{PAIR_ADDRESS}
```
- Recent Swaps 탭에서 실제 거래 가격 확인
- 타임스탬프 일치 여부 확인

### DEX Screener로 확인
```
https://dexscreener.com/ethereum/{PAIR_ADDRESS}
```

- 1분 차트에서 해당 시점 가격 확인

## 2. 가스비 검증 (Gas Cost Verification)

### 실제 가스비 계산
Flash Loan Arbitrage의 평균 가스 소비:
- Aave V3 Flash Loan: ~150,000 gas
- Uniswap V2 Swap: ~110,000 gas
- Uniswap V3 Swap: ~130,000 gas
- **Total: ~390,000 gas**

현재 가스비가 30 Gwei라면:
```
Gas Cost = 390,000 × 30 / 1e9 = 0.0117 ETH
Gas Cost USD = 0.0117 × $3,095 = $36.21
```

UI에 표시된 가스비가 이 범위 안에 있는지 확인하세요.

## 3. Flash Loan Fee 검증

### Aave V3 Flash Loan Fee
- Fee: **0.05%** of borrowed amount
- 1 ETH 빌린 경우: 0.0005 ETH = $1.55 (ETH @ $3,095)

계산:
```
Flash Loan Fee = Amount × 0.0005 × ETH Price
               = 1 ETH × 0.0005 × $3,095
               = $1.55
```

## 4. 순이익 계산 검증 (Net Profit Verification)

### 전체 계산식
```
Net Profit = Gross Profit - Gas Cost - Flash Loan Fee

예시:
Gross Profit: $12.91
Gas Cost: $1.55 (30 Gwei)
Flash Loan Fee: $1.55
Net Profit: $12.91 - $1.55 - $1.55 = $9.81
```

UI에서 표시된 Net Profit이 이 계산과 일치하는지 확인하세요.

## 5. 실시간 검증 (Real-time Verification)

### 로그에서 확인할 정보
Activity Logs에서 다음 정보를 확인하세요:

```
✅ WETH/USDC: UNISWAP_V2 ($1234.56) → UNISWAP_V3 ($1239.67) | Net: $11.24
📊 Details: Gross: $12.91 - Gas: $1.55 - FL Fee: $1.55 = Net: $9.81
🔗 Verify: Buy @ uniswap_v2 pair 0xa478c2975ab1ea89e8196811f51a7b7ade33eb11... | Sell @ uniswap_v3 pair 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640...
```

각 항목을 Etherscan에서 확인:
1. Buy pair 주소로 Uniswap V2 가격 확인
2. Sell pair 주소로 Uniswap V3 가격 확인
3. 스프레드 계산: (Sell - Buy) / Buy × 100

## 6. 실제 메인넷 배포 전 검증 (Pre-deployment Validation)

### Tenderly Simulation (추천)
1. [Tenderly](https://tenderly.co) 계정 생성
2. Fork Network 생성 (Ethereum Mainnet)
3. 스마트 컨트랙트 시뮬레이션:
   ```solidity
   // Flash Loan → Buy → Sell → Repay 시뮬레이션
   ```
4. 실제 결과와 예측 비교

### 소액 테스트넷 실행
1. Sepolia에서 먼저 테스트
2. 모든 플로우가 정상 작동하는지 확인
3. 가스비, 슬리피지 실제 측정

### 메인넷 소액 테스트
1. **0.01 ETH** 정도로 먼저 테스트
2. 실제 수익률 측정
3. 여러 번 반복하여 일관성 확인

## 7. 리스크 체크리스트

실제 배포 전 다음을 확인하세요:

- [ ] **Price Slippage**: 큰 거래량일 경우 가격 슬리피지 발생 가능
- [ ] **Front-running**: MEV bot들이 먼저 실행할 수 있음
- [ ] **Gas Spike**: 갑자기 가스비 급등으로 수익 감소
- [ ] **Liquidity**: 충분한 유동성이 있는지 확인
- [ ] **Timing**: 기회 발견 후 실행까지 시간 차로 가격 변동
- [ ] **Smart Contract Risk**: 플래시론 컨트랙트 버그 가능성

## 8. 수익성 판단 기준

### 안전한 차익거래 조건
```
Net Profit > $50              ✅ 권장 (가스비 변동 고려)
Net Profit $20 - $50          ⚠️  주의 (리스크 있음)
Net Profit < $20              ❌ 비추천 (수수료로 손실 가능)
```

### 추가 고려사항
- **Price Spread > 0.5%**: 최소 스프레드
- **Liquidity > $1M**: 충분한 유동성
- **Gas < 50 Gwei**: 높은 가스비는 수익 감소

## 9. 검증 도구 (Tools)

- **DEXTools**: https://www.dextools.io/
- **DEX Screener**: https://dexscreener.com/
- **Etherscan**: https://etherscan.io/
- **Tenderly**: https://tenderly.co/
- **Flashbots**: https://protect.flashbots.net/ (Front-running 방지)

## 10. 결론

**검증 단계:**
1. ✅ 가격이 실제 DEX와 일치하는가?
2. ✅ 가스비 계산이 정확한가?
3. ✅ Flash Loan 수수료가 포함되었는가?
4. ✅ 순이익이 최소 $50 이상인가?
5. ✅ 타이밍과 슬리피지를 고려했는가?

모든 항목이 ✅라면 실제 수익 가능성이 높습니다!

---

**주의사항:**
- 이 가이드는 교육 목적입니다
- 실제 메인넷 배포는 신중하게 결정하세요
- 항상 소액으로 먼저 테스트하세요
- 손실 가능성을 항상 고려하세요
