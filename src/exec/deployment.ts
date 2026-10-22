import type { SubmitResult } from './pimlico.js';

export interface UserOpConfirmation {
  landed: boolean;
  success: boolean;
}

export interface DeploymentOwnershipSteps {
  submitDeployment: () => Promise<SubmitResult>;
  waitForUserOp: (hash: string) => Promise<UserOpConfirmation>;
  getCode: () => Promise<string>;
  submitOwnershipTransfer: () => Promise<SubmitResult>;
  getOwner: () => Promise<string>;
  expectedOwner: string;
}

async function submitAndConfirm(
  submit: () => Promise<SubmitResult>,
  waitForUserOp: DeploymentOwnershipSteps['waitForUserOp'],
  label: string,
): Promise<void> {
  const result = await submit();
  if (result.kind !== 'sent' || !result.userOpHash) {
    throw new Error(`${label} UserOp was not sent: ${result.reason ?? result.kind}`);
  }

  const receipt = await waitForUserOp(result.userOpHash);
  if (!receipt.landed || !receipt.success) {
    throw new Error(`${label} UserOp did not land successfully: ${result.userOpHash}`);
  }
}

export async function deployAndTransferOwnership(
  steps: DeploymentOwnershipSteps,
): Promise<void> {
  await submitAndConfirm(steps.submitDeployment, steps.waitForUserOp, 'CREATE2 deployment');

  const code = await steps.getCode();
  if (!code || /^0x0*$/i.test(code)) {
    throw new Error('CREATE2 deployment receipt succeeded but executor code is absent');
  }

  await submitAndConfirm(
    steps.submitOwnershipTransfer,
    steps.waitForUserOp,
    'executor ownership transfer',
  );

  const actualOwner = await steps.getOwner();
  if (actualOwner.toLowerCase() !== steps.expectedOwner.toLowerCase()) {
    throw new Error(
      `executor ownership mismatch: expected ${steps.expectedOwner}, got ${actualOwner}`,
    );
  }
}
