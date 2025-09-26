# Prompts Management

This folder contains all AI prompts used by the Privacy Guardian Gateway system.

## Structure

```
prompts/
├── privacy/
│   ├── privacy_analysis.txt     # Main AI privacy detection prompt
│   └── README.md               # Privacy prompts documentation
├── ner/
│   ├── basic_ner.txt           # Basic named entity recognition
│   └── README.md               # NER prompts documentation
└── system/
    └── README.md               # System prompts (future use)
```

## Usage

Use the `PromptLoader` utility to load prompts:

```python
from privacy_guardian.prompt_loader import prompt_loader

# Load privacy analysis prompt
prompt = prompt_loader.get_privacy_analysis_prompt("user text here")

# Load basic NER prompt  
ner_prompt = prompt_loader.get_basic_ner_prompt("text to analyze")
```

## Benefits

- **Centralized Management**: All prompts in one location
- **Easy Modification**: Edit prompts without touching code
- **Version Control**: Track prompt changes separately
- **Caching**: Automatic caching for performance
- **Template Support**: Variable substitution (e.g., {text})

## Adding New Prompts

1. Create a new `.txt` file in the appropriate category folder
2. Use `{variable}` syntax for template variables
3. Update the `PromptLoader` class if needed for convenience methods
4. Document the prompt in the category's README.md