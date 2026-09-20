import { checkoutWip, repoIdentity } from "./shadow.js";
import type { VerifiedSnapshot } from "./snapshot-evidence.js";

/** The latest checkpoint can be newer than the last remotely verified snapshot.
 * Checkout must use the same exact snapshot as the displayed bootstrap, and never
 * perform filesystem work for a refused claim or another repository. */
export function checkoutResumeSnapshot(root:string, pack:{snapshot:VerifiedSnapshot|null;claim:{acquired:boolean}}, mode:"continue"|"fork"|"inspect", destination:string):string {
  if(!["continue","fork","inspect"].includes(mode)) throw new Error("Invalid resume mode");
  if(mode !== "inspect" && !pack.claim.acquired) throw new Error("Cannot check out a continuation after its claim was refused");
  const snapshot=pack.snapshot;
  if(!snapshot || snapshot.status !== "verified" || !snapshot.commit || !snapshot.ref || !Number.isFinite(new Date(snapshot.verified_at).getTime())) throw new Error("No remotely verified snapshot is available for checkout");
  if(repoIdentity(root) !== snapshot.repo) throw new Error("--checkout requires a checkout of the verified snapshot's repository");
  return checkoutWip(root,snapshot.ref,snapshot.commit,destination);
}
