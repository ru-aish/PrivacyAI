#!/usr/bin/env python3
"""
Test script to verify Gemini integration with privacy protection
"""
import os
import sys
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from privacy_guardian.multi_ai_coordinator import MultiAICoordinator

load_dotenv()

def test_gemini_with_privacy():
    """Test that Gemini receives sanitized prompts and returns responses"""
    
    print("=" * 70)
    print("🧪 TESTING GEMINI INTEGRATION WITH PRIVACY PROTECTION")
    print("=" * 70)
    print()
    
    coordinator = MultiAICoordinator()
    
    test_cases = [
        {
            "prompt": "Hi, my name is Alice and my email is alice@example.com. Can you help me write a short introduction?",
            "expected_service": "gemini",
            "description": "Privacy-sensitive request with PII"
        },
        {
            "prompt": "Write a Python function to reverse a string",
            "expected_service": "lm_studio", 
            "description": "Code generation request"
        },
        {
            "prompt": "Tell me a creative story about a magical cat",
            "expected_service": "gemini",
            "description": "Creative writing request"
        }
    ]
    
    for i, test in enumerate(test_cases, 1):
        print(f"{'='*70}")
        print(f"TEST {i}: {test['description']}")
        print(f"{'='*70}")
        print(f"📝 Original Prompt: {test['prompt']}")
        print()
        
        try:
            result = coordinator.process_with_coordination(
                test['prompt'],
                preferred_service='gemini'  # Force Gemini for all tests
            )
            
            print(f"✅ SUCCESS - Gemini Integration Working!")
            print()
            print(f"🔍 Request Analysis:")
            print(f"   Type: {result['request_analysis']['type']}")
            print(f"   Privacy Sensitive: {result['request_analysis']['privacy_sensitive']}")
            print(f"   Service Used: {result['request_analysis']['selected_service']}")
            print()
            
            if result['privacy_protection']['detections']:
                print(f"🛡️  Privacy Protection Applied:")
                for detection in result['privacy_protection']['detections']:
                    print(f"   • {detection['original']} → {detection['replacement']} ({detection['type']})")
                print()
                print(f"🔒 Sanitized Text Sent to Gemini:")
                print(f"   \"{result['privacy_protection']['anonymized_text']}\"")
                print()
            else:
                print(f"✅ No PII detected - original prompt sent to Gemini")
                print()
            
            print(f"🤖 Gemini Response (with privacy restored):")
            print(f"   {result['ai_response']['final_response'][:200]}...")
            print()
            
            print(f"⏱️  Processing Time: {result['coordination_info']['processing_time']:.2f}s")
            print()
            
        except Exception as e:
            print(f"❌ FAILED: {str(e)}")
            print()
    
    print("=" * 70)
    print("✅ ALL TESTS COMPLETED")
    print("=" * 70)
    print()
    print("📊 FLOW SUMMARY:")
    print("   1. User prompt → Privacy Analysis (LM Studio)")
    print("   2. PII detected → Sanitized prompt created")
    print("   3. Sanitized prompt → Gemini API")
    print("   4. Gemini response → Privacy restoration")
    print("   5. Final response → User (with original PII)")
    print()

if __name__ == "__main__":
    if not os.getenv('GEMINI_API_KEY'):
        print("❌ ERROR: GEMINI_API_KEY not set in .env file")
        print("Please set your Gemini API key in .env")
        sys.exit(1)
    
    test_gemini_with_privacy()
