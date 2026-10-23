/**
 * Balancer Vault ABI for Flash Loans
 * Contract: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 * Docs: https://docs.balancer.fi/reference/contracts/flash-loans.html
 */

export const BALANCER_VAULT_ABI = [
  {
    inputs: [
      {
        internalType: "contract IFlashLoanRecipient",
        name: "recipient",
        type: "address",
      },
      {
        internalType: "contract IERC20[]",
        name: "tokens",
        type: "address[]",
      },
      {
        internalType: "uint256[]",
        name: "amounts",
        type: "uint256[]",
      },
      {
        internalType: "bytes",
        name: "userData",
        type: "bytes",
      },
    ],
    name: "flashLoan",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "contract IERC20",
        name: "token",
        type: "address",
      },
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    name: "getInternalBalance",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Flash Loan Recipient Interface
 * Contract must implement this to receive flash loans from Balancer
 */
export const FLASH_LOAN_RECIPIENT_ABI = [
  {
    inputs: [
      {
        internalType: "contract IERC20[]",
        name: "tokens",
        type: "address[]",
      },
      {
        internalType: "uint256[]",
        name: "amounts",
        type: "uint256[]",
      },
      {
        internalType: "uint256[]",
        name: "feeAmounts",
        type: "uint256[]",
      },
      {
        internalType: "bytes",
        name: "userData",
        type: "bytes",
      },
    ],
    name: "receiveFlashLoan",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

