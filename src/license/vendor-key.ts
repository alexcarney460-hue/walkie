// The vendor's license-signing PUBLIC key (raw ed25519, base64). Every Walkie binary verifies
// licenses offline against this key and nothing else: there is no env or config override. The
// matching private key lives only in ~/keys/walkie-license-signing.key and the site's
// WALKIE_LICENSE_SIGNING_KEY env var (docs/BUSINESS.md "How licensing works").
export const VENDOR_PUBLIC_KEY_B64 = "MGBsUknkf2XnCPY6LawlhMKAl0fc4CrIGuZ3rDqJnsA=";
