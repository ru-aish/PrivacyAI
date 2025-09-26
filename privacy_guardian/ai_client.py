"""
AI Service clients for Gemini and LM Studio integration
"""
import os
import requests
from typing import Dict, Any, Optional
from google import genai
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class GeminiClient:
    """Client for Google Gemini API using new google-genai package"""
    
    def __init__(self):
        self.api_key = os.getenv('GEMINI_API_KEY')
        self.model = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
        
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY environment variable is required")
        
        # Set up the client
        os.environ['GOOGLE_API_KEY'] = self.api_key
        self.client = genai.Client()
    
    def generate_response(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """Generate response using Gemini API"""
        try:
            # Combine system prompt and user prompt if system prompt provided
            if system_prompt:
                full_prompt = f"System: {system_prompt}\n\nUser: {prompt}"
            else:
                full_prompt = prompt
            
            response = self.client.models.generate_content(
                model=self.model,
                contents=full_prompt
            )
            
            return response.text
            
        except Exception as e:
            raise Exception(f"Gemini API error: {str(e)}")

class LMStudioClient:
    """Client for LM Studio local API"""
    
    def __init__(self):
        self.base_url = os.getenv('LM_STUDIO_BASE_URL', 'http://localhost:1234')
        self.model = os.getenv('LM_STUDIO_MODEL', 'qwen2.5-coder-3b-instruct')
        self.endpoint = f"{self.base_url}/v1/chat/completions"
    
    def generate_response(self, prompt: str, system_prompt: Optional[str] = None) -> str:
        """Generate response using LM Studio API"""
        try:
            messages = []
            
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            
            messages.append({"role": "user", "content": prompt})
            
            payload = {
                "model": self.model,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": -1,
                "stream": False
            }
            
            response = requests.post(
                self.endpoint,
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=30
            )
            
            response.raise_for_status()
            
            result = response.json()
            return result['choices'][0]['message']['content']
            
        except requests.exceptions.RequestException as e:
            raise Exception(f"LM Studio API error: {str(e)}")
        except KeyError as e:
            raise Exception(f"Unexpected LM Studio response format: {str(e)}")

class AIServiceManager:
    """Manager for AI services with fallback support"""
    
    def __init__(self):
        self.default_service = os.getenv('DEFAULT_AI_SERVICE', 'lm_studio')
        self.gemini_client = None
        self.lm_studio_client = None
        
        # Initialize clients
        try:
            self.gemini_client = GeminiClient()
        except Exception as e:
            print(f"Warning: Gemini client initialization failed: {e}")
        
        try:
            self.lm_studio_client = LMStudioClient()
        except Exception as e:
            print(f"Warning: LM Studio client initialization failed: {e}")
    
    def generate_response(self, prompt: str, system_prompt: Optional[str] = None, 
                         service: Optional[str] = None) -> str:
        """Generate response using specified or default AI service"""
        
        service = service or self.default_service
        
        # Try primary service
        if service == 'gemini' and self.gemini_client:
            try:
                return self.gemini_client.generate_response(prompt, system_prompt)
            except Exception as e:
                print(f"Gemini failed: {e}, trying LM Studio fallback...")
                if self.lm_studio_client:
                    return self.lm_studio_client.generate_response(prompt, system_prompt)
                raise
                
        elif service == 'lm_studio' and self.lm_studio_client:
            try:
                return self.lm_studio_client.generate_response(prompt, system_prompt)
            except Exception as e:
                print(f"LM Studio failed: {e}, trying Gemini fallback...")
                if self.gemini_client:
                    return self.gemini_client.generate_response(prompt, system_prompt)
                raise
        
        # If we get here, no service is available
        raise Exception(f"No AI service available. Service '{service}' failed or not configured.")
    
    def test_connection(self, service: str) -> Dict[str, Any]:
        """Test connection to specified AI service"""
        test_prompt = "Hello, please respond with 'Connection successful'"
        
        try:
            if service == 'gemini' and self.gemini_client:
                response = self.gemini_client.generate_response(test_prompt)
                return {"status": "success", "service": "gemini", "response": response}
            elif service == 'lm_studio' and self.lm_studio_client:
                response = self.lm_studio_client.generate_response(test_prompt)
                return {"status": "success", "service": "lm_studio", "response": response}
            else:
                return {"status": "error", "service": service, "error": "Service not available"}
        except Exception as e:
            return {"status": "error", "service": service, "error": str(e)}