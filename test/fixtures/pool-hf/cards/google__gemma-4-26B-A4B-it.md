---
library_name: transformers
license: apache-2.0
license_link: https://ai.google.dev/gemma/docs/gemma_4_license
pipeline_tag: image-text-to-text
base_model:
- google/gemma-4-26B-A4B
---

<div align="center">
  <img src=https://ai.google.dev/gemma/images/gemma4_banner.png>
</div>


<p align="center">
    <a href="https://huggingface.co/collections/google/gemma-4" target="_blank">Hugging Face</a> |
    <a href="https://github.com/google-gemma" target="_blank">GitHub</a> |
    <a href="https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/" target="_blank">Launch Blog</a> |

[... trimmed ...]
ding space through lightweight linear layers. This unified approach means all modalities flow straight into a single decoder-only transformer, reducing multimodal latency and allowing the entire model to be fine-tuned in one pass.

### Mixture-of-Experts (MoE) Model

| Property | 26B A4B MoE |
| :---- | :---- |
| **Total Parameters** | 25.2B |
| **Active Parameters** | 3.8B |
| **Layers** | 30 |
| **Sliding Window** | 1024 tokens |
| **Context Length** | 256K tokens |
| **Vocabulary Size** | 262K |
| **Expert Count** | 8 active / 128 total and 1 shared |
| **Supported Modalities** | Text, Image |
| **Vision Encoder Parameters** | *~550M* |

The "A" in 26B A4B stands for "active parameters" in contrast to the total number of parameters the model contains. By only activating a 4B subset of parameters during inference, the Mixture-of-Experts model runs much faster than its 26B total might suggest. This makes it an excellent choice for fast inference compared to the dense 31B model since it runs almost as fast as a 4B-parame
[... trimmed ...]
f model training and development.

* **Content Creation and Communication**  
  * **Text Generation**: These models can be used to generate creative text formats such as poems, scripts, code, marketing copy, and email drafts.  
  * **Chatbots and Conversational AI**: Power conversational interfaces for customer service, virtual assistants, or interactive applications.  
  * **Text Summarization**: Generate concise summaries of a text corpus, research papers, or reports.  
  * **Image Data Extraction**: These models can be used to extract, interpret, and summarize visual data for text communications.  
  * **Audio Processing and Interaction**: The E2B, E4B, and 12B models can analyze and interpret 
[... trimmed ...]
ce-driven interactions and transcriptions.  
* **Research and Education**  
  * **Natural Language Processing (NLP) and VLM Research**: These models can serve as a foundation for researchers to experiment with VLM and NLP techniques, develop algorithms, and contribute to the advancement of the field.  
  * **Language Learning Tools**: Support interactive language learning experiences, aiding in grammar correction or providing writing practice.  
  * **Knowledge Exploration**: Assist researchers in exploring large bodies of text by generating summaries or answering questions about specific topics.

### **Limitations**

* **Training Data**  
  * The quality and diversity of the training data signifi