export type CopyStatus = "idle" | "copied" | "error";
export type CopyEvent = "copy-success" | "copy-error" | "reset";

export function reduceCopyStatus(_status: CopyStatus, event: CopyEvent): CopyStatus {
  if (event === "copy-success") return "copied";
  if (event === "copy-error") return "error";
  return "idle";
}
