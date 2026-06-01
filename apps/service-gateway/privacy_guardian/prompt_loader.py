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
            filename: Filename without extension (e.g., 'priv
import java.util.*;

class Matrix2x2 {

    double[][] values;
    final int matrixId;
    static int count = 0;

   
    // matrix 1
    public Matrix2x2(double a, double b, double c, double d) {
        this.values = new double[][]{{a, b}, {c, d}};
        count++;
        this.matrixId = count;
    }
    // matrix 2
    public Matrix2x2(Matrix2x2 other) {
        this.values = new double[2][2];
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                this.values[i][j] = other.values[i][j];
            }
        }
        count++;
        this.matrixId = count;
    }

    public double determinant() {
        return (values[0][0] * values[1][1]) - (values[0][1] * values[1][0]);
    }

    public double trace() {
        return values[0][0] + values[1][1];
    }

    public Matrix2x2 add(Matrix2x2 m) {
        return new Matrix2x2(
            this.values[0][0] + m.values[0][0],
            this.values[0][1] + m.values[0][1],
            this.values[1][0] + m.values[1][0],
            this.values[1][1] + m.values[1][1]
        );
    }

    public Matrix2x2 multiply(Matrix2x2 m) {
        double a = this.values[0][0] * m.values[0][0] + this.values[0][1] * m.values[1][0];
        double b = this.values[0][0] * m.values[0][1] + this.values[0][1] * m.values[1][1];
        double c = this.values[1][0] * m.values[0][0] + this.values[1][1] * m.values[1][0];
        double d = this.values[1][0] * m.values[0][1] + this.values[1][1] * m.values[1][1];
        return new Matrix2x2(a, b, c, d);
    }

    // instade of int*double , int to double then mul....
    public void scale(int k) {
        scale((double) k);
    }

    public void scale(double k) {
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                this.values[i][j] *= k;
            }
        }
    }

    @Override
    public String toString() {
        return String.format("[%.2f %.2f] [%.2f %.2f]",
            values[0][0], values[0][1], values[1][0], values[1][1]);
    }


    public static int getCount() {
        return count;
    }

    public static void main(String[] args) {
        Matrix2x2 m1 = new Matrix2x2(1, 2, 3, 4);
        System.out.println("Matrix M1 (ID " + m1.matrixId + "): " + m1);

        Matrix2x2 m2 = new Matrix2x2(2, 0, 1, 2);
        System.out.println("Matrix M2 (ID " + m2.matrixId + "): " + m2);

        Matrix2x2 m3 = m1.multiply(m2);
        System.out.println("Matrix M3 = M1 * M2 (ID " + m3.matrixId + "): " + m3);
        
        System.out.println("Determinant of M3: " + m3.determinant());
        System.out.println("Total Matrices Created: " + Matrix2x2.getCount());
    }
}
acy_analysis')
            
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
        """Get the privacy analysis prompt with text appended as plain text."""
        raw_prompt = self.load_prompt("privacy", "privacy_analysis")
        # Simple string replacement - no Python template processing
        return raw_prompt.replace("{text}", text)
    
    def get_basic_ner_prompt(self, text: str) -> str:
        """Get the basic NER prompt with text appended as plain text."""
        raw_prompt = self.load_prompt("ner", "basic_ner")
        # Simple string replacement - no Python template processing
        return raw_prompt.replace("{text}", text)
    
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