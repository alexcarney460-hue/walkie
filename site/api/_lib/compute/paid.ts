// Alex (binding): "our card on file is strictly for upselling compute to users". The provider account exists ONLY to
// run machines customers have paid for, so a tier backed by a real provider (anything but FakeCloud) launches only
// against PAID credit (Stripe livemode purchases; see Tx.paidBalance): never test-mode credit, free adjustments,
// internal or test teams. FakeCloud (tests, demo) spends any credit because it spends nothing of ours.
import type { PrivateConfig } from "./private-config.js";
import type { TierId } from "./types.js";

export const FAKE_PROVIDER = "fake";

export const isRealProvider = (cfg: PrivateConfig, tier: TierId): boolean => cfg.tiers[tier].provider !== FAKE_PROVIDER;
