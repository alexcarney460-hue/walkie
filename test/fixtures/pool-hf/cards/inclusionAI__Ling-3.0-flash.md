---
license: mit
pipeline_tag: text-generation
---
<p align="center">
    <img src="https://mdn.alipayobjects.com/huamei_qa8qxu/afts/img/A*4QxcQrBlTiAAAAAAQXAAAAgAemJ7AQ/original" width="100"/>
</p>
<p align="center">🤗 <a href="https://huggingface.co/inclusionAI">Hugging Face</a>&nbsp;&nbsp; | &nbsp;&nbsp;🤖 <a href="https://modelscope.cn/organization/inclusionAI">ModelScope </a>&nbsp;&nbsp; | &nbsp;&nbsp;🐙 <a href="https://openrouter.ai/inclusionai/ling-3.0-flash:free">OpenRouter </a>&nbsp;&nbsp;</p>

## Introduction
We're introducing Ling-3.0-flash, our next-generation native hybrid reasoning
[... trimmed ...]
 model. Operating with **124B** total and **5.1B** active parameters (~12.4% and ~8.1% of our previous 1T-class flagship Ring-2.6-1T), Ling-3.0-flash matches or outperforms its predecessor across key benchmarks.

Key highlights of the model are summarized below:

+ **Native Hybrid-Linear Architecture:** Ling-3.0 adopts a native hybrid linear attention architecture from the very start of pretraining (5:1 alternating stacking of Kimi Delta Attention (KDA) and MLA), upgraded with KDA fine-grained diagonal gating and 1/64 sparse MoE. With 124B total parameters and 5.1B activated parameters, it achieves a synergistic leap in long-context efficiency and computational cost.
+ **Remarkable Efficiency & Performance:** Engineered for speed, compute efficiency, and production deployment, Ling-3.0-flash delivers class-defying performance against both larger SOTA competitors and previous-generation flagships. Activating only 5.1B parameters per token, it provides impressive reasoning, instruction following, and long-context capabilities to empower complex agentic workflows in production environments.
+ **Comprehensive Agentic Evolution:** Tailored for real-world productivity workflows, the model incorporates 10,000+ interactive training environments to achieve end-to-end closed-loop execution across Coding, General, and Deep Research Agent tasks. It natively integrates the SGLang HiCache + Mooncake hierarchical caching architecture (featuring physical dual-pools and a cluster-shared L3 cache), eliminating redundant recomputation during long-horizon interactions and reduc
[... trimmed ...]
<!-- Benchmark comparison chart across models -->
![](https://intranetproxy.alipay.com/skylark/lark/0/2026/png/23157180/1785831264180-d6ca4404-acef-4424-84db-fbc5a4c6db5f.png)

## Model Overview
The model summary information and architecture diagram are as follows:

| Architecture | Hybrid-linear MoE |
| --- | --- |
| Parameter Scale | Total 124B, Activated 5.1B |
| Transformer Layers | 35 KDA + 7 Gated MLA (5:1) |
| Number of Dense Layers | 2 |
| Number of Routed Experts | 512 |
| Number of Shared Experts | 1 |
| Number of Activated Experts | 8 |
| Attention Heads | 32 |
| Hidden Size | 2560 |
| Expert Intermediate Size | 768 |
| Dense Intermediate Size | 6144 |
| Vocabulary Size | 157184 |
| Context Training Schedule | 8K -> 32K -> 256K |

<!-- Ling-3.0-flash architecture diagram -->
![](https://cdn-uploads.huggingface.co/production/uploads/675fc648a63fff7b5be452f6/Psj43kxXZ
[... trimmed ...]
t Terminus 2 harness, a unified 2-hour timeout, the provided JSON parser in preserve-thinking mode, and 3 runs per task (mean). Decoding uses `temperature=0.6, top_p=1.0, max_new_tokens=32K`, with a 256K context window.
> + MiniAppBench: A 500-task coding benchmark evaluating whether models can turn a single user request into complete, usable interactive HTML apps in real-world application-generation scenarios. Evaluated with `temperature=1.0, top_p=1.0, max_tokens=128K`.
> + AntSWEBench: AntSWEBench is an internally used software engineering benchmark that covers mainstream programming languages such as Java, JavaScript, and Python, including various development scenarios like new feature, bug fi