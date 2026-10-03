# Hugging Face Hub fixtures (LOCAL-MODELS-HF-1)

Real, trimmed responses of the public Hub API, read on 2026-10-01 with plain unauthenticated GETs. They answer the
tests through `test/helpers/hf-fixtures.ts` (a fake `fetch`); no test touches the network. A file that is absent is a
request the Hub answered 401 (a missing or gated repository) or 404 (an organisation that is a person's account).

| Folder | Request | Trimmed to |
|---|---|---|
| `lists/<pipeline_tag>.<sort>.json` | `/api/models?filter=gguf&pipeline_tag=<tag>&sort=<downloads\|trendingScore>&limit=<n>&expand[]=baseModels&expand[]=downloads&expand[]=createdAt` | the repositories that map to the fixture models plus a few unrelated ones, in the Hub's order |
| `models/<owner>__<name>.json` | `/api/models/<id>?expand[]=baseModels&expand[]=createdAt&expand[]=downloads&expand[]=likes&expand[]=gated&expand[]=pipeline_tag&expand[]=safetensors&expand[]=sha&expand[]=tags&expand[]=evalResults` | `evalResults` kept for the nine benchmarks of `quality.ts`, every malformed `{filename, error}` entry, and two other benchmarks |
| `quants/<owner>__<name>.json` | `/api/models?filter=base_model:quantized:<id>&filter=gguf&sort=downloads&limit=50&expand[]=downloads` | the base's own and the four trusted quantizers' repositories plus up to four other accounts' copies |
| `blobs/<owner>__<repo>.json` | `/api/models/<repo>?blobs=true&expand[]=siblings&expand[]=sha&expand[]=downloads` | `siblings` limited to the Q4_K_M / UD-Q4_K_M / MXFP4 / Q8_0 files and a few side files (mmproj, imatrix, MTP, other quantizations) |
| `orgs/<name>.json` | `/api/organizations/<name>/overview` | `_id, fullname, name, isVerified, plan, numModels, numFollowers` |
| `configs/<owner>__<name>.json` | `/<id>/resolve/main/config.json` (307 to a relative `/api/resolve-cache/...`, then 200 text/plain) | whole file |
| `cards/<owner>__<name>.md` | `/<id>/resolve/main/README.md` | the first 600 characters and up to six windows (350 characters each side) around the word "active/activated/activates", byte for byte, joined by `[... trimmed ...]` |
| `machines/mac-m5-16gb-*.txt` | `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`, `vm_stat`, `sysctl -n machdep.cpu.brand_string hw.optional.arm64 iogpu.wired_limit_mb` | a 16 GB Apple M5 Mac (the machine the work was done on), busy: about 10 GB wired, swap in use |

The GB10 captures live next to the other machine stats in `test/fixtures/machine-stats/` (`nvidia-smi-gb10*.txt`,
`meminfo-gb10-spark-*.txt`, `cpuinfo-gb10-aarch64.txt`; spark-115f and spark-0e86, DGX OS 7.2.3).

What the fixture models are for: Qwen3.8-27B (hybrid linear attention, nested `text_config`, Unsloth's only 4-bit file is
`UD-Q4_K_M`), Qwen3.6-35B-A3B (A3B name token), gpt-oss-20b/120b (active parameters only in the card, sliding window,
native MXFP4), Gemma 4 12B / 31B / E4B (sliding + global head sizes, `E4B` token), Qwen3.8-Flash-Next (card: 125B of
180B with 6B active; sharded GGUF), Ling-3.0-flash, Step-3.7-Flash (card sentence style), GLM-5.3-Flash (latent
attention, no 4-bit file yet), GLM-4.7-Flash (a Mixture of Experts whose card states no active parameters),
Nemotron-3.5-Lightning (`layers_block_type`), LFM2.5 (conv layers; malformed evaluation entries), Ornith-1.5-9B (the maker's
own GGUF without a base_model tag), Ornith-1.0-35B (a checkpoint whose `safetensors.total` reads 664944);
and the ones that must be left out: orcarouter/Qwen3.8-27B-Uncensored and unsloth/Qwen3.5-9B (fine-tunes of someone
else's weights), XingChen-AGI/Xing4.0-29B-A4B (a 300-follower account), Qwen3.5-2B-Base (a checkpoint), Qwen3-8B (too
old), google/gemma-3n-E4B-it (gated: its config needs a login).
