# System Prompts

This folder is reserved for system-level prompts that can be applied to AI responses.

## Future Use Cases

- Default system prompts for different AI services
- Role-based system prompts (coding assistant, creative writer, etc.)  
- Context-specific system prompts
- Safety and guidelines prompts

## Usage

System prompts will be loaded using the same PromptLoader utility:

```python
system_prompt = prompt_loader.load_prompt("system", "coding_assistant")
```