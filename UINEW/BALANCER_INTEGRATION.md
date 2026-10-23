# Balancer Flash Loan Integration

## 개요

Balancer 플래시론을 프로젝트에 통합하여 **0% 수수료**로 아비트라지를 실행할 수 있게 되었습니다.

## 주요 변경 사항

### 1. Smart Contract 업데이트

#### FlashLoanArbitrage.sol
- Balancer Vault 인터페이스 추가
- `IFlashLoanRecipient` 인터페이스 구현
- `receiveFlashLoan()` 콜백 함수 추가
- `requestBalancerFlashLoan()` 함수 추가
- `FlashProvider` enum에 `BALANCER` 추가

```solidity
// Balancer Vault Interface
interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

// Balancer Flash Loan Callback
function receiveFlashLoan(
    address[] memory tokens,
    uint256[] memory amounts,
    uint256[] memory feeAmounts,  // All zeros for Balancer!
    bytes memory userData
) external override;
```

### 2. ABI 추가

#### lib/abis/balancerVault.ts
- `BALANCER_VAULT_ABI`: Balancer Vault 컨트랙트 ABI
- `FLASH_LOAN_RECIPIENT_ABI`: 플래시론 수신자 인터페이스

### 3. 실행 로직 업데이트

#### lib/utils/execute-arbitrage.ts
- 플래시론 프로토콜별 수수료 계산 추가
- Balancer: 0%
- Aave V3: 0.09%
- Uniswap V3: 0.05%

```typescript
const FLASH_LOAN_FEES: Record<string, number> = {
  "AAVE_V3": 0.09,      // 0.09% (9 bps)
  "UNISWAP_V3": 0.05,   // 0.05% (5 bps)
  "BALANCER": 0.0,      // 0% (free!)
};
```

### 4. 설정 업데이트

#### lib/config.ts
- 기본 플래시론 프로토콜을 Balancer로 변경
- `DEFAULT_ARBITRAGE_SETTINGS.flashLoanProtocol = FlashLoanProtocol.BALANCER`

#### lib/config/high-liquidity-pairs.ts
- `ARBITRAGE_STRATEGY.flashLoanFeePercent = 0.0` (Balancer 기본값)

## 플래시론 프로토콜 비교

| 프로토콜 | 수수료 | 장점 | 단점 |
|---------|--------|------|------|
| **Balancer** | **0%** | **수수료 없음, 가장 저렴** | 가스비는 여전히 발생 |
| Aave V3 | 0.09% | 안정적, 높은 유동성 | 수수료 있음 |
| Uniswap V3 | 0.05% | 낮은 수수료 | 제한적인 토큰 쌍 |

## 사용법

### 1. 컨트랙트 배포

```bash
# Hardhat fork를 먼저 시작
npx hardhat node --fork $NEXT_PUBLIC_ETH_RPC_URL

# 새 터미널에서 Balancer 지원 컨트랙트 배포
npx hardhat run scripts/deploy-fork-balancer.ts --network localhost
```

### 2. 환경 변수 설정

`.env.local` 파일에 배포된 컨트랙트 주소 추가:

```env
NEXT_PUBLIC_CONTRACT_ADDRESS=0x...
```

### 3. 모니터링 시작

기본 설정이 Balancer로 되어 있으므로, 그대로 스캐너를 시작하면 됩니다.

```bash
npm run dev
```

## 기술적 세부사항

### Balancer Flash Loan 흐름

```
1. Contract calls BALANCER_VAULT.flashLoan()
   ├─ recipient: FlashLoanArbitrage contract
   ├─ tokens: [WETH]
   ├─ amounts: [9 ETH]
   └─ userData: Encoded arbitrage parameters

2. Balancer Vault transfers tokens to recipient

3. Balancer Vault calls receiveFlashLoan() callback
   ├─ tokens: [WETH]
   ├─ amounts: [9 ETH]
   ├─ feeAmounts: [0]  ← Always 0 for Balancer!
   └─ userData: Original params

4. Contract executes arbitrage
   ├─ Buy token on DEX A
   ├─ Sell token on DEX B
   └─ Calculate profit

5. Contract repays flash loan
   └─ Transfer exact borrowed amount (no fee!)
```

### Aave V3 vs Balancer 비교

| 항목 | Aave V3 | Balancer |
|------|---------|----------|
| **수수료** | 0.09% | 0% |
| **콜백 함수** | `executeOperation()` | `receiveFlashLoan()` |
| **상환 방식** | Approve + Pool pulls | Direct transfer to Vault |
| **상환 금액** | amount + premium | amount (premium = 0) |
| **인터페이스** | Separate | Must implement `IFlashLoanRecipient` |

## 실제 사용 통계

Ethereum Mainnet에서의 플래시론 사용량:
- Balancer: **10,464회** (압도적 1위)
- Aave V3: 1,658회
- Uniswap V3: 5회

이는 Balancer의 0% 수수료가 실제 트레이더들에게 선호되는 이유를 보여줍니다.

## 예상 비용 절감

### 9 ETH 플래시론 기준 (@$3,500/ETH)

| 프로토콜 | 수수료 | 플래시론 비용 |
|---------|--------|-------------|
| Aave V3 | 0.09% | $28.35 |
| Uniswap V3 | 0.05% | $15.75 |
| **Balancer** | **0%** | **$0** |

→ Balancer 사용 시 **$28.35 절감** (Aave V3 대비)

## 다음 단계

1. ✅ Balancer Vault ABI 추가
2. ✅ FlashLoanArbitrage 컨트랙트에 Balancer 지원 추가
3. ✅ execute-arbitrage.ts에 Balancer 실행 로직 추가
4. ✅ UI 설정에 Balancer 옵션 표시 (기본값으로 설정)
5. ⏳ 테스트 및 검증
6. 📋 메인넷 배포 준비
7. 📋 실제 아비트라지 실행 테스트

## 참고 자료

- [Balancer Flash Loan Docs](https://docs.balancer.fi/reference/contracts/flash-loans.html)
- Balancer Vault: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`
- 실제 트랜잭션 예시:
  - `0x5e9e1dd5c2c9d119952a38eaa2d4f1c1436cfe40eda27e5585018105a36c36fa`
  - `0xafa2e39178c4cd117c3af9f1382d0d6195794f82d29462a379c1ffd5398936eb`

