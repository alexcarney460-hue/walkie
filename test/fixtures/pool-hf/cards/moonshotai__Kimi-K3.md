---
tags:
- compressed-tensors
- conversational
license: other
license_name: "kimi-k3"
library_name: transformers
pipeline_tag: image-text-to-text
---
<div align="center">
  <picture>
      <img src="assets/kimi-logo.png" width="30%" alt="Kimi K3">
  </picture>
</div>
<hr>
<div align="center" style="line-height:1">
  <a href="https://www.kimi.com" target="_blank"><img alt="Chat" src="https://img.shields.io/badge/🤖%20Chat-Kimi%20K3-ff6b6b?color=1783ff&logoColor=white"/></a>
  <a href="https://www.moonshot.ai" target="_blank"><img alt="Homepage" src="https://img.shields.io/badge/Homepage-Moonsho
[... trimmed ...]
oken context window. It is the world's first open 3T-class model, designed for frontier intelligence across long-horizon coding, knowledge work, and reasoning.

### Key Features
- **New Architecture**: Kimi K3 is built on Kimi Delta Attention (KDA) and Attention Residuals (AttnRes), and scales up MoE sparsity with a Stable LatentMoE framework that activates 16 out of 896 experts — yielding an approximate 2.5× improvement in overall scaling efficiency over Kimi K2.
- **Long-Horizon Coding**: Operating with minimal human oversight, Kimi K3 sustains long engineering sessions, navigates massive repositories, and orchestrates terminal tools — from GPU kernel optimization and compiler development to vision-in-the-loop game dev, CAD, and even chip design.
- **Agentic Knowledge Work**: Kimi K3 advances end-to-end knowledge work, producing deep research with interactive visualizations, widgets and dashboards, and motion design and video editing, powered by its native multimodal architecture.
- **Native Multimodality & Long Context**: Kimi K3 understands text, images, and video within the same model, and supports a 1-million-token context window.
- **Open Frontier Weights**: We release the full Kimi K3 model weigh
[... trimmed ...]
n: middle; text-align: center">Mixture-of-Experts (MoE)</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Total Parameters</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">2.8T</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Activated Parameters</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">104B</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Number of Layers</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">93</td>
</tr>
<tr>
<td align="center" style="vertical-
[... trimmed ...]
: middle; text-align: center">1048576</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Attention Mechanism</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">KDA &amp; Gated MLA</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Activation Function</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">SiTU-GLU</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Vision Encoder</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">MoonViT-V2</td>
</tr>
<tr>
<td align="center" style="v
[... trimmed ...]
n: center"><strong>Parameters of Vision Encoder</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">401M</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Quantization</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">MXFP4 weights / MXFP8 activations<br>(quantization-aware training)</td>
</tr>
<tr>
<td align="center" style="vertical-align: middle; text-align: center"><strong>Modality</strong></td>
<td align="center" style="vertical-align: middle; text-align: center">Text, Image</td>
</tr>
</tbody>
</table>
</div>


## 3. Evaluation Results

<div align="center">
<table>
<thead>
<tr>
<th align=
[... trimmed ...]
 official protocol, preserving the original input order and prepending images to the text input.
   - **PerceptionBench** is an in-house benchmark that focuses on atomic visual perception capabilities.

</details>

## 4. Native MXFP4 Quantization

Kimi K3 applies quantization-aware training from the SFT stage onward, using MXFP4 weights with MXFP8 activations for broad hardware compatibility.

## 5. Deployment

> [!Note]
> You can access Kimi K3's API on https://platform.kimi.ai by selecting `kimi-k3`, and we provide OpenAI/Anthropic-compatible API for you. Currently, Kimi K3 is recommended to run on the following inference engines:

- [vLLM](https://github.com/vllm-project/vllm) — see [recipes](https