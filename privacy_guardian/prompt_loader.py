"""
Prompt Loader Utility

Centralizes all AI prompts in external files for easy management and modification.
"""

import os
from typing import Dict, Optional
from pathlib import Path


class PromptLoader:
    """Utility class to load prompts from external files."""
    
    def __init__(self):
        # Get the directory where this file is located
        self.base_dir = Path(__file__).parent.parent
        self.prompts_dir = self.base_dir / "prompts"
        
        # Cache for loaded prompts
        self._prompt_cache: Dict[str, str] = {}
    
    def load_prompt(self, category: str, filename: str) -> str:
        """
        Load a prompt from file.
        
        Args:
            category: Prompt category (privacy, ner, system)
            filename: Filename without extension (e.g., 'privacy_analysis')
            
        Returns:
            Prompt text as string
            
        Raises:
            FileNotFoundError: If prompt file doesn't exist
        """
        cache_key = f"{category}/{filename}"
        
        # Return cached version if available
        if cache_key in self._prompt_cache:
            return self._prompt_cache[cache_key]
        
        # Construct file path
        prompt_file = self.prompts_dir / category / f"{filename}.txt"
        
        if not prompt_file.exists():
            raise FileNotFoundError(f"Prompt file not found: {prompt_file}")
        
        # Load and cache the prompt
        with open(prompt_file, 'r', encoding='utf-8') as f:
            prompt_text = f.read().strip()
        
        self._prompt_cache[cache_key] = prompt_text
        return prompt_text
    
    def get_privacy_analysis_prompt(self, text: str) -> str:
        """Get the privacy analysis prompt with text substituted."""
        template = self.load_prompt("privacy", "privacy_analysis")
        return template.format(text=text)
    
    def get_basic_ner_prompt(self, text: str) -> str:
        """Get the basic NER prompt with text substituted."""
        template = self.load_prompt("ner", "basic_ner")
        return template.format(text=text)
    
    def clear_cache(self):
        """Clear the prompt cache."""
        self._prompt_cache.clear()
    
    def reload_prompt(self, category: str, filename: str) -> str:
        """Reload a specific prompt (clears cache for that prompt)."""
        cache_key = f"{category}/{filename}"
        if cache_key in self._prompt_cache:
            del self._prompt_cache[cache_key]
        return self.load_prompt(category, filename)


# Global instance for easy import
prompt_loader = PromptLoader()


# Convenience functions for backward compatibility
def get_privacy_analysis_prompt(text: str) -> str:
    """Get privacy analysis prompt with text substituted."""
    return prompt_loader.get_privacy_analysis_prompt(text)


def get_basic_ner_prompt(text: str) -> str:
    """Get basic NER prompt with text substituted."""
    return prompt_loader.get_basic_ner_prompt(text)