---
license: mit
library_name: transformers
---
# DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence

<!-- markdownlint-disable first-line-h1 -->
<!-- markdownlint-disable html -->
<!-- markdownlint-disable no-duplicate-header -->

<div align="center">
  <img src="https://github.com/deepseek-ai/DeepSeek-V2/blob/main/figures/logo.svg?raw=true" width="60%" alt="DeepSeek-V4" />
</div>
<hr>
<div align="center" style="line-height: 1;">
  <a href="https://www.deepseek.com/" target="_blank" style="margin: 2px;">
    <img alt="Homepage" src="https://github.com/deepseek-ai/DeepSee
[... trimmed ...]
="display: inline-block; vertical-align: middle;"/>
  </a>
</div>

<p align="center">
  <a href="https://arxiv.org/abs/2606.19348"><b>Technical Report</b>👁️</a>
</p>

## Introduction

We present a preview version of **DeepSeek-V4** series, including two strong Mixture-of-Experts (MoE) language models — **DeepSeek-V4-Pro** with 1.6T parameters (49B activated) and **DeepSeek-V4-Flash** with 284B parameters (13B activated) — both supporting a context length of **one million tokens**.

DeepSeek-V4 series incorporate several key upgrades in architecture and optimization:

1. **Hybrid Attention Architecture:** We design a hybrid attention mechanism combining Compressed Sparse Attention (CSA) and Heavily Compressed Attention (HCA) to dramatically improve long-context e
[... trimmed ...]
ormance to the Pro version when given a larger thinking budget, though its smaller parameter scale naturally places it slightly behind on pure knowledge tasks and the most complex agentic workflows.

<div align="center">
 <img src="assets/dsv4_performance.png" >
</div>

## Model Downloads

<div align="center">

| **Model** | **#Total Params** | **#Activated Params** | **Context Length** | **Precision** | **Download** |
| :---: | :---: | :---: | :---: | :---: | :---: |
| DeepSeek-V4-Flash-Base | 284B | 13B | 1M | FP8 Mixed | [HuggingFace](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Base) \| [ModelScope](https://modelscope.cn/models/deepseek-ai/DeepSeek-V4-Flash-Base) |
| DeepSeek-V4-Flash | 2
[... trimmed ...]

</div>

*\*FP4 + FP8 Mixed: MoE expert parameters use FP4 precision; most other parameters use FP8.*

## Evaluation Results

### Base Model

<div align="center">

| Benchmark (Metric) | # Shots | DeepSeek-V3.2-Base | DeepSeek-V4-Flash-Base | DeepSeek-V4-Pro-Base |
| :--- | :---: | :---: | :---: | :---: |
| Architecture | - | MoE | MoE | MoE |
| # Activated Params | - | 37B | 13B | 49B |
| # Total Params | - | 671B | 284B | 1.6T |
| **World Knowledge** | | | | |
| AGIEval (EM) | 0-shot | 80.1 | 82.6 | **83.1** |
| MMLU (EM) | 5-shot | 87.8 | 88.7 | **90.1** |
| MMLU-Redux (EM) | 5-shot | 87.5 | 89.4 | **90.8** |
| MMLU-Pro (EM) | 5-shot | 65.5 | 68.3 | **73.5** |
| MMMLU (EM) | 5-shot | 87.9 | 88.8 |
[... trimmed ...]


# string -> tokens
import transformers
tokenizer = transformers.AutoTokenizer.from_pretrained("deepseek-ai/DeepSeek-V4-Pro")
tokens = tokenizer.encode(prompt)
```

## How to Run Locally

Please refer to the [inference](inference/README.md) folder for detailed instructions on running DeepSeek-V4 locally, including model weight conversion and interactive chat demos.

For local deployment, we recommend setting the sampling parameters to `temperature = 1.0, top_p = 1.0`. For the Think Max reasoning mode, we recommend setting the context window to at least **384K** tokens.

## License

This repository and the model weights are licensed under the [MIT License](LICENSE).

## Citation

```
@misc{deepsee