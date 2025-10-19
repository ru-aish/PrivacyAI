"""
Multi-AI Service Coordinator - Advanced Architecture

This module coordinates between multiple AI services to provide optimal
privacy protection and AI responses:

1. LM Studio: Privacy analysis, code generation, technical tasks
2. Gemini: General conversation, creative tasks, complex reasoning
3. Smart routing: Automatic service selection based on request type
4. Load balancing: Distribute requests across available services
5. Failover: Automatic fallback between services
"""

import os
import time
import asyncio
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass
from enum import Enum
from .ai_client import AIServiceManager, GeminiClient, LMStudioClient
from .sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
from .sanitizer.processor import PrivacyProcessor


class RequestType(Enum):
    """Types of requests that can be routed to different services."""
    PRIVACY_ANALYSIS = "privacy_analysis"
    GENERAL_CHAT = "general_chat"
    CODE_GENERATION = "code_generation"
    CREATIVE_WRITING = "creative_writing"
    TECHNICAL_ANALYSIS = "technical_analysis"
    REASONING = "reasoning"


@dataclass
class ServiceCapabilities:
    """Capabilities and preferences for each AI service."""
    privacy_analysis: float  # 0.0-1.0 capability score
    code_generation: float
    creative_writing: float
    general_chat: float
    technical_analysis: float
    reasoning: float
    response_time_avg: float  # Average response time in seconds
    reliability: float  # 0.0-1.0 reliability score


@dataclass
class RequestContext:
    """Context information for routing requests."""
    request_type: RequestType
    privacy_sensitive: bool
    estimated_complexity: float  # 0.0-1.0
    user_preference: Optional[str] = None
    require_privacy_analysis: bool = True


class MultiAICoordinator:
    """
    Advanced Multi-AI Service Coordinator
    
    This coordinates between multiple AI services to provide optimal
    privacy protection and responses based on request characteristics.
    """
    
    def __init__(self):
        # Initialize base services
        self.ai_manager = AIServiceManager()
        self.privacy_analyzer = AIPrivacyAnalyzer()
        self.privacy_processor = PrivacyProcessor()
        
        # Service capabilities (can be learned over time)
        # Gemini is STRONGLY PREFERRED - LM Studio only used as fallback
        self.service_capabilities = {
            'lm_studio': ServiceCapabilities(
                privacy_analysis=0.95,      # Excellent for privacy
                code_generation=0.60,       # Fallback only
                creative_writing=0.40,      # Fallback only
                general_chat=0.50,          # Fallback only
                technical_analysis=0.60,    # Fallback only
                reasoning=0.55,             # Fallback only
                response_time_avg=2.5,      # Fast local response
                reliability=0.90            # Very reliable when running
            ),
            'gemini': ServiceCapabilities(
                privacy_analysis=0.50,      # Basic privacy understanding
                code_generation=0.95,       # PREFERRED for code
                creative_writing=0.99,      # PREFERRED for creative
                general_chat=0.99,          # PREFERRED for chat
                technical_analysis=0.95,    # PREFERRED for technical
                reasoning=0.99,             # PREFERRED for reasoning
                response_time_avg=3.2,      # Cloud response time
                reliability=0.99            # Highly reliable cloud service
            )
        }
        
        # Performance tracking
        self.service_metrics = {
            'lm_studio': {'requests': 0, 'failures': 0, 'avg_response_time': 2.5},
            'gemini': {'requests': 0, 'failures': 0, 'avg_response_time': 3.2}
        }
        
    def analyze_request_type(self, prompt: str, system_prompt: Optional[str] = None) -> RequestContext:
        """
        Analyze the request to determine optimal routing.
        
        Args:
            prompt: User's prompt
            system_prompt: Optional system prompt
            
        Returns:
            RequestContext with routing information
        """
        prompt_lower = prompt.lower()
        
        # Check for privacy-sensitive content
        privacy_keywords = ['name', 'email', 'phone', 'address', 'personal', 'private']
        privacy_sensitive = any(keyword in prompt_lower for keyword in privacy_keywords)
        
        # Determine request type based on content analysis
        if any(word in prompt_lower for word in ['code', 'program', 'function', 'class', 'import', 'def']):
            request_type = RequestType.CODE_GENERATION
            complexity = 0.7
        elif any(word in prompt_lower for word in ['story', 'poem', 'creative', 'imagine', 'write a']):
            request_type = RequestType.CREATIVE_WRITING
            complexity = 0.6
        elif any(word in prompt_lower for word in ['analyze', 'technical', 'explain', 'how does', 'why']):
            request_type = RequestType.TECHNICAL_ANALYSIS
            complexity = 0.8
        elif any(word in prompt_lower for word in ['solve', 'calculate', 'reason', 'logic', 'problem']):
            request_type = RequestType.REASONING
            complexity = 0.9
        else:
            request_type = RequestType.GENERAL_CHAT
            complexity = 0.4
        
        return RequestContext(
            request_type=request_type,
            privacy_sensitive=privacy_sensitive,
            estimated_complexity=complexity,
            require_privacy_analysis=privacy_sensitive
        )
    
    def select_optimal_service(self, context: RequestContext) -> str:
        """
        Select the optimal AI service based on request context.
        
        Args:
            context: Request context information
            
        Returns:
            Service name ('lm_studio' or 'gemini')
        """
        # If user has a preference, respect it
        if context.user_preference and context.user_preference in self.service_capabilities:
            return context.user_preference
        
        # Calculate scores for each service
        scores = {}
        
        for service, capabilities in self.service_capabilities.items():
            # Get capability score based on request type
            if context.request_type == RequestType.PRIVACY_ANALYSIS:
                capability_score = capabilities.privacy_analysis
            elif context.request_type == RequestType.CODE_GENERATION:
                capability_score = capabilities.code_generation
            elif context.request_type == RequestType.CREATIVE_WRITING:
                capability_score = capabilities.creative_writing
            elif context.request_type == RequestType.TECHNICAL_ANALYSIS:
                capability_score = capabilities.technical_analysis
            elif context.request_type == RequestType.REASONING:
                capability_score = capabilities.reasoning
            else:  # GENERAL_CHAT
                capability_score = capabilities.general_chat
            
            # Factor in reliability and response time
            reliability_score = capabilities.reliability
            time_score = 1.0 / (capabilities.response_time_avg / 2.0)  # Prefer faster services
            
            # Calculate weighted score
            total_score = (
                capability_score * 0.6 +      # 60% capability
                reliability_score * 0.3 +     # 30% reliability  
                time_score * 0.1              # 10% speed
            )
            
            # No bonus - Gemini is always preferred unless it fails
            
            scores[service] = total_score
        
        # Select service with highest score
        return max(scores.items(), key=lambda x: x[1])[0]
    
    def process_with_coordination(self, prompt: str, system_prompt: Optional[str] = None,
                                preferred_service: Optional[str] = None) -> Dict[str, Any]:
        """
        Process request with full multi-AI coordination.
        
        Flow:
        1. Always prefer Gemini API (cloud)
        2. Anonymize prompt before sending to Gemini
        3. If Gemini fails, fallback to LM Studio with ORIGINAL prompt (no anonymization)
        4. Clearly indicate when using local fallback
        
        Args:
            prompt: User's prompt
            system_prompt: Optional system prompt
            preferred_service: User's preferred service
            
        Returns:
            Detailed processing result with multi-level information
        """
        start_time = time.time()
        
        # Step 1: Analyze request context
        context = self.analyze_request_type(prompt, system_prompt)
        if preferred_service:
            context.user_preference = preferred_service
        
        # Step 2: Always do privacy analysis with LM Studio (for Gemini usage)
        privacy_result = self.privacy_analyzer.analyze_and_anonymize(prompt)
        
        # Step 3: Select optimal service for main AI response (should be Gemini)
        selected_service = self.select_optimal_service(context)
        
        # Track if we used fallback and whether we used anonymization
        used_fallback = False
        used_anonymization = True
        
        # Step 4: Try Gemini first with anonymized prompt
        try:
            if selected_service == 'gemini':
                # Use anonymized text for Gemini
                ai_response = self.ai_manager.generate_response(
                    privacy_result['anonymized_text'],
                    system_prompt=system_prompt,
                    service='gemini'
                )
                self.service_metrics['gemini']['requests'] += 1
            else:
                # If LM Studio selected (rare), use original prompt
                ai_response = self.ai_manager.generate_response(
                    prompt,
                    system_prompt=system_prompt,
                    service='lm_studio'
                )
                used_anonymization = False
                self.service_metrics['lm_studio']['requests'] += 1
            
        except Exception as e:
            print(f"⚠️  Primary service {selected_service} failed: {e}")
            print(f"🔄 Falling back to local LM Studio with original prompt (no anonymization needed)")
            
            # Fallback to LM Studio with ORIGINAL prompt (no anonymization)
            try:
                ai_response = self.ai_manager.generate_response(
                    prompt,  # Use original prompt for local processing
                    system_prompt=system_prompt,
                    service='lm_studio'
                )
                selected_service = 'lm_studio'
                used_fallback = True
                used_anonymization = False
                self.service_metrics['lm_studio']['requests'] += 1
            except Exception as fallback_error:
                self.service_metrics[selected_service]['failures'] += 1
                raise Exception(f"Both services failed. Primary: {e}, Fallback: {fallback_error}")
        
        # Step 5: De-sanitize response only if we used anonymization
        if used_anonymization and privacy_result['session_map']:
            final_response = self.privacy_processor.desanitize(
                ai_response,
                privacy_result['session_map']
            )
        else:
            # No anonymization was used, return as-is
            final_response = ai_response
        
        processing_time = time.time() - start_time
        
        return {
            'original_prompt': prompt,
            'request_analysis': {
                'type': context.request_type.value,
                'privacy_sensitive': context.privacy_sensitive,
                'complexity': context.estimated_complexity,
                'selected_service': selected_service
            },
            'privacy_protection': {
                'original_text': privacy_result['original_text'],
                'anonymized_text': privacy_result['anonymized_text'] if used_anonymization else prompt,
                'detections': [
                    {
                        'original': d.original_text,
                        'replacement': d.replacement_text,
                        'type': d.privacy_type,
                        'confidence': d.confidence
                    } for d in privacy_result['detections']
                ] if used_anonymization else [],
                'session_map': privacy_result['session_map'] if used_anonymization else {},
                'ai_powered': privacy_result['ai_powered'],
                'anonymization_used': used_anonymization
            },
            'ai_response': {
                'service_used': selected_service,
                'sanitized_response': ai_response,
                'final_response': final_response,
                'used_fallback': used_fallback,
                'anonymization_applied': used_anonymization
            },
            'coordination_info': {
                'processing_time': processing_time,
                'privacy_service': 'lm_studio' if used_anonymization else 'none',
                'main_ai_service': selected_service,
                'service_scores': self._calculate_current_scores(context),
                'used_fallback': used_fallback,
                'fallback_reason': 'Gemini API unavailable' if used_fallback else None
            }
        }
    
    def _calculate_current_scores(self, context: RequestContext) -> Dict[str, float]:
        """Calculate current service scores for transparency."""
        scores = {}
        
        for service, capabilities in self.service_capabilities.items():
            if context.request_type == RequestType.CODE_GENERATION:
                capability_score = capabilities.code_generation
            elif context.request_type == RequestType.CREATIVE_WRITING:
                capability_score = capabilities.creative_writing
            elif context.request_type == RequestType.TECHNICAL_ANALYSIS:
                capability_score = capabilities.technical_analysis
            elif context.request_type == RequestType.REASONING:
                capability_score = capabilities.reasoning
            else:
                capability_score = capabilities.general_chat
            
            scores[service] = capability_score
        
        return scores
    
    def get_service_status(self) -> Dict[str, Any]:
        """Get current status of all coordinated services."""
        return {
            'privacy_analyzer': {
                'status': 'available' if self.privacy_analyzer._is_ai_available() else 'unavailable',
                'service': 'lm_studio'
            },
            'ai_services': {
                'lm_studio': self.ai_manager.test_connection('lm_studio'),
                'gemini': self.ai_manager.test_connection('gemini')
            },
            'coordination_metrics': self.service_metrics,
            'service_capabilities': {
                service: {
                    'privacy_analysis': caps.privacy_analysis,
                    'code_generation': caps.code_generation,
                    'creative_writing': caps.creative_writing,
                    'general_chat': caps.general_chat,
                    'technical_analysis': caps.technical_analysis,
                    'reasoning': caps.reasoning,
                    'avg_response_time': caps.response_time_avg,
                    'reliability': caps.reliability
                }
                for service, caps in self.service_capabilities.items()
            }
        }
    
    def update_service_performance(self, service: str, response_time: float, success: bool):
        """Update service performance metrics for better routing decisions."""
        metrics = self.service_metrics[service]
        
        if success:
            # Update average response time with exponential moving average
            metrics['avg_response_time'] = (
                0.8 * metrics['avg_response_time'] + 0.2 * response_time
            )
            # Update capabilities response time
            self.service_capabilities[service].response_time_avg = metrics['avg_response_time']
        else:
            metrics['failures'] += 1
            # Slightly reduce reliability score
            current_reliability = self.service_capabilities[service].reliability
            self.service_capabilities[service].reliability = max(0.1, current_reliability * 0.95)


# Example usage and testing
if __name__ == "__main__":
    def test_multi_ai_coordinator():
        """Test the Multi-AI Coordinator with various request types."""
        coordinator = MultiAICoordinator()
        
        test_cases = [
            ("Write a Python function to calculate fibonacci numbers", None),
            ("Tell me a creative story about a robot", None),
            ("My name is John and my email is john@example.com, help me write a resume", None),
            ("Explain how machine learning works", None),
            ("What's the weather like today?", None)
        ]
        
        print("🚀 TESTING MULTI-AI COORDINATOR")
        print("=" * 60)
        
        for i, (prompt, system_prompt) in enumerate(test_cases, 1):
            print(f"\n📝 TEST {i}: {prompt}")
            print("-" * 40)
            
            try:
                result = coordinator.process_with_coordination(prompt, system_prompt)
                
                print(f"🎯 Request Type: {result['request_analysis']['type']}")
                print(f"🔒 Privacy Sensitive: {result['request_analysis']['privacy_sensitive']}")
                print(f"🤖 Selected Service: {result['request_analysis']['selected_service']}")
                print(f"⚡ Processing Time: {result['coordination_info']['processing_time']:.2f}s")
                
                if result['privacy_protection']['detections']:
                    print("🛡️  Privacy Protections:")
                    for detection in result['privacy_protection']['detections']:
                        print(f"   • {detection['original']} → {detection['replacement']}")
                else:
                    print("✅ No privacy issues detected")
                
                print(f"💬 Final Response: {result['ai_response']['final_response'][:100]}...")
                
            except Exception as e:
                print(f"❌ Error: {e}")
        
        # Print service status
        print(f"\n📊 SERVICE STATUS:")
        print("-" * 40)
        status = coordinator.get_service_status()
        print(f"Privacy Analyzer: {status['privacy_analyzer']['status']}")
        for service, test_result in status['ai_services'].items():
            print(f"{service.upper()}: {test_result['status']}")
    
    test_multi_ai_coordinator()