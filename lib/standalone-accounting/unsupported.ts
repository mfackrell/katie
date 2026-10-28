/** These paths have no supported immutable billing estimator yet. Fail before
 * transmitting even if the provider happens to be configured. */
export function blockUnaccountedPaidDispatch(activity: string): void {
  throw Object.assign(new Error(`Paid dispatch blocked: ${activity} requires supported pricing and standalone attempt accounting.`), {
    code: 'standalone_unsupported_billing', terminal: true,
  });
}
