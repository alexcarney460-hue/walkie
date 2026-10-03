---
library_name: transformers
license: mit
license_link: https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B/blob/main/LICENSE
pipeline_tag: text-generation
---


<img width="600px" src="assets/ornith_logo.png">

[![Ornith Blog](https://img.shields.io/badge/%F0%9F%A6%A2%EF%B8%8F%20Ornith%20Blog%20-FD8E5B)](https://deep-reinforce.com/ornith.html)


# Ornith-1.5-35B-A3B


Chirp Chirp! 🐦 We are introducing Ornith-1.5, a major step toward building foundation models through end-to-end self-improvement.

Ornith-1.5 extends Ornith-1.0 (which was developed on top of Qwen3.5 and Gemma4 with additional
[... trimmed ...]
o our [blog](https://ornith.ai/ornith_1_5.html).

<img style="width: 100%; max-width: 900px;" src="assets/ornith_35b_eval.png" alt="Ornith 1.5 35B Benchmark Results" title="Ornith 1.5 35B Benchmark Results">

## Ornith 1.5 35B-A3B

This model card documents **Ornith-1.5-35B-A3B**, the mid-size mixture-of-experts member of the Ornith-1.5 family. It activates only ~3B parameters per token, yet significantly outperforms its similar-sized peer Qwen 3.6-35B across all coding and agentic benchmarks, and outperforms dense models such as Gemma 4-31B and Muse Glimmer-30B by wide margins on agentic coding.

### Benchmarks


<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;w
[... trimmed ...]
und:rgba(253,142,91,0.15);padding:1px 5px;border-radius:4px">top_k=20</code></li>
<li><b>To reproduce the reported benchmarks:</b> <code style="background:rgba(253,142,91,0.15);padding:1px 5px;border-radius:4px">temperature=1.0</code></li>
</ul>
</div>


### Serving Ornith-1.5-35B-A3B

Ornith-1.5-35B-A3B is a ~35B mixture-of-experts model with ~3B activated parameters per token (≈70 GB in bf16). The recipes below stand up an OpenAI-compatible server on **2× 80GB GPUs** to leave headroom for the 256K context; adjust `--tensor-parallel-size` / `--tp` to match your hardware.

#### vLLM

```bash
vllm serve ornith-ai/Ornith-1.5-35B-A3B \
    --served-model-name Ornith-1.5-35B-A3B \
    --host 0.0.0.0 --po