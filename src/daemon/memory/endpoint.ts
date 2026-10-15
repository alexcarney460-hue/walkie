import { isIP } from "node:net";
import { bareLetters, readable } from "../../protocol/projects/status-report.ts";

const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi;
const PROTOCOL_RELATIVE_URL = /(?:^|[^\p{L}\p{N}\p{M}/:])\/\/[\p{L}\p{N}]/iu;
const HOST_WITH_PORT = /(?<![\p{L}\p{N}\p{M}_.-])([\p{L}\p{N}\p{M}_-]+(?:\.[\p{L}\p{N}\p{M}_-]+)*):([0-9]{1,5})(?=$|[^\p{L}\p{N}\p{M}_.-])/giu;
const HOST_AFTER_KEY = /\b(?:host|hostname|server|endpoint|db_host|url)\s*[:=]\s*([^\s,;!?/#]+)/gi;
const DOTTED_NAME = /(?<![\p{L}\p{N}\p{M}_.-])(?:[\p{L}\p{N}\p{M}_-]+\.)+[\p{L}\p{N}\p{M}_-]+(?![\p{L}\p{N}\p{M}_.-])/giu;
const PUNYCODE_LABEL = /(?<![\p{L}\p{N}\p{M}_.-])xn--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?![\p{L}\p{N}\p{M}_.-])/iu;
const FILE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cpp", "css", "csv", "go", "gz", "h", "hpp", "html", "java", "jpeg", "jpg",
  "js", "json", "jsx", "kt", "lock", "log", "md", "pdf", "php", "png", "py", "rb", "rs", "scss",
  "sh", "sql", "svelte", "svg", "swift", "tar", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zip",
]);
const SERVICE_PORTS = new Set([22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 1433,
  1521, 2375, 2376, 2379, 3000, 3306, 4000, 5000, 5432, 5672, 6379, 6443, 8000,
  8080, 8443, 9000, 9090, 9200, 11211, 15672, 27017]);
const INFRA_LABELS = new Set(["internal", "local", "lan", "corp", "intranet", "localdomain"]);
const INFRA_SUFFIXES = ["home.arpa", "compute.internal", "svc.cluster.local", "amazonaws.com", "azurewebsites.net", "cloudapp.net", "googleusercontent.com", "fly.dev", "vercel.app", "supabase.co"];
const IPV4 = /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])/g;
const BRACKETED_IP = /\[([0-9a-f:.%_-]+)\](?::[0-9]{1,5})?/gi;
const IPV6 = /(?<![a-z0-9:.])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.%_-]*/gi;

function ip(candidate: string): boolean {
  return isIP(candidate.replace(/%[a-z0-9._-]+$/i, "")) !== 0;
}

function dottedName(candidate: string): boolean {
  const name = candidate.toLowerCase();
  const labels = name.split(".");
  if (labels.some((label) => INFRA_LABELS.has(label))) return true;
  if (INFRA_SUFFIXES.some((suffix) => `.${name}.`.includes(`.${suffix}.`))) return true;
  if (labels.some((label) => /^xn--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return true;
  const final = labels.at(-1)!;
  return labels.length >= 3 && /^[\p{L}\p{N}\p{M}]{2,63}$/u.test(final) && !FILE_EXTENSIONS.has(final);
}

function hostLikeValue(candidate: string): boolean {
  const value = candidate.replace(/[.)]+$/, "");
  return ip(value) || value.includes(".") || [...value.matchAll(HOST_WITH_PORT)].some(hostWithPort);
}

function hostWithPort(match: RegExpMatchArray): boolean {
  const label = match[1]!.toLowerCase();
  return label.includes(".") || label === "localhost" || /[-\p{N}]/u.test(label)
    || SERVICE_PORTS.has(Number(match[2]));
}

function urlHasHost(candidate: string): boolean {
  try { return !!new URL(candidate).hostname; }
  catch { return false; }
}

function classified(value: string): boolean {
  if ([...value.matchAll(SCHEME_URL)].some((match) => urlHasHost(match[0]))) return true;
  if (PROTOCOL_RELATIVE_URL.test(value)) return true;
  if ([...value.matchAll(HOST_WITH_PORT)].some(hostWithPort)) return true;
  if ([...value.matchAll(HOST_AFTER_KEY)].some((match) => hostLikeValue(match[1]!))) return true;
  if ([...value.matchAll(DOTTED_NAME)].some((match) => dottedName(match[0]))) return true;
  if (PUNYCODE_LABEL.test(value)) return true;
  if ([...value.matchAll(IPV4)].some((match) => ip(match[0]))) return true;
  if ([...value.matchAll(BRACKETED_IP)].some((match) => ip(match[1]!))) return true;
  return [...value.matchAll(IPV6)].some((match) => ip(match[0]));
}

/** Conservative text classification, shared by learning writes and legacy reads. */
export function containsNetworkEndpoint(text: string): boolean {
  const shown = readable(text);
  const forms = new Set([shown, bareLetters(shown)]);
  for (let pass = 0; pass < 2; pass++) {
    for (const value of [...forms]) {
      try {
        const decoded = decodeURIComponent(value);
        forms.add(decoded);
        forms.add(bareLetters(readable(decoded)));
      } catch { /* A literal or malformed percent sign leaves the other forms available. */ }
    }
  }
  return [...forms].some(classified);
}
