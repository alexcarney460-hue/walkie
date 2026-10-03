---
license: apache-2.0
license_link: https://www.apache.org/licenses/LICENSE-2.0
pipeline_tag: image-text-to-text
tags:
- conversational
- image-text-to-text
- audio-text-to-text
- moe
library_name: transformers
---

# Inkling

<img src="https://cdn-uploads.huggingface.co/production/uploads/630e8f0bf6f6d700f50ebd2e/AvmDwmrWRMnKjOWvmLieg.png" style="display: block;margin-left: auto;margin-right: auto;width: 30%;">

<p align="center">
  <a href="https://huggingface.co/thinkingmachines/Inkling-Small">BF16</a> |
  <a href="https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4">NVFP4</a> |
 
[... trimmed ...]
nes-inkling))

API access is also available through third party inference providers.

## 3. Model Properties

### Model type

Multimodal autoregressive transformer

### Architecture type

A 42-layer decoder-only transformer with a sparse Mixture-of-Experts (MoE) feed-forward backbone: each token is routed to 6 of 256 experts, plus 2 shared experts active on every token. Attention is a hybrid of local and global layers. The model is natively multimodal — images are encoded via a hierarchical patch encoder, and audio via discrete token encoding — with all modalities projected into a shared hidden space and processed jointly by the decoder.

### Parameters

276B total, 12B active

### Numerics support

BF16 and NVFP4

### Input modalities

Inkling-Small accepts text, image, and audio inputs:

- Text: UTF-8 encoded text
- Image: Any pixel-based image input. For optimal performance, each image dimension should be between 40px to 4096px.
- Audio: WAV format, sampled at 16kHz. For optimal performance, audio length should ideal
[... trimmed ...]
38.0%</td>
        <td class="benchmark-value">41.0%</td>
        <td class="benchmark-value">30.0%</td>
        <td class="benchmark-value">36.0%</td>
        <td class="benchmark-value">49.0%</td>
      </tr>
      <tr>
        <td class="benchmark-name">
          <span class="benchmark-title">Params (B)</span> <span class="benchmark-subtitle">(activated / total)</span>
        </td>
        <td class="benchmark-value benchmark-instant-start"><span class="benchmark-lock-content">12 / 276</span></td>
        <td class="benchmark-value">17 / 397</td>
        <td class="benchmark-value">15 / 310</td>
        <td class="benchmark-value">10 / 230</td>
        <td class="benchmark-value">13 / 284</td>
 
[... trimmed ...]
        <td class="benchmark-value">–</td>
        <td class="benchmark-value">91.4%</td>
        <td class="benchmark-value">–</td>
        <td class="benchmark-value">85.9%</td>
        <td class="benchmark-value">–</td>
      </tr>
    </tbody>
  </table>

- <small>Inkling-Small against open-and closed-weights models across the full eval suite. Activated and total parameters are given for scale; a dash means the score was not available at the time of writing.</small>
- <small>SWEBench Verified: Inkling and Inkling-Small’s numbers are reported using a bash-only harness. We use self-reported numbers for external models.</small>
- <small>Terminal Bench 2.1: Inkling and Inkling-Small’s numbers are rep