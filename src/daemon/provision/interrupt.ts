export class ProvisionInterrupted extends Error {
  constructor(readonly reason: string) { super("provision step interrupted"); }
}
