#!/usr/bin/env python3
"""
Simple example demonstrating Gemini integration with privacy protection

This shows the complete flow:
1. User provides prompt with PII
2. Privacy system sanitizes it
3. Sanitized prompt goes to Gemini
4. Gemini responds
5. Response is de-sanitized with original PII restored
"""

import os
import sys
from dotenv import load_dotenv

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from privacy_guardian.multi_ai_coordinator import MultiAICoordinator
from privacy_guardian.sanitizer.processor import PrivacyProcessor

def simple_example():
    """Simple example showing the complete flow"""
    
    print("🔐 GEMINI INTEGRATION WITH PRIVACY PROTECTION")
    print("=" * 70)
    print()
    
    # Initialize coordinator
    coordinator = MultiAICoordinator()
    
    # Example prompt with PII
    user_prompt = "Hi! My name is Sarah Johnson and my email is sarah.j@email.com. Can you help me write a professional introduction for LinkedIn?"
    
    print("📝 USER PROMPT (with PII):")
    print(f'   "{user_prompt}"')
    print()
    
    print("⚙️  PROCESSING...")
    print()
    
    # Process with privacy protection
    result = coordinator.process_with_coordination(
        user_prompt,
        preferred_service='gemini'  # Use Gemini
    )
    
    # Show what happened
    print("🔍 PRIVACY ANALYSIS RESULTS:")
    print(f"   Privacy Sensitive: {result['request_analysis']['privacy_sensitive']}")
    print(f"   Detections Found: {len(result['privacy_protection']['detections'])}")
    print()
    
    if result['privacy_protection']['detections']:
        print("🛡️  PII DETECTED & PROTECTED:")
        for detection in result['privacy_protection']['detections']:
            print(f"   • {detection['type']}: '{detection['original']}' → '{detection['replacement']}'")
        print()
    
    print("🔒 SANITIZED PROMPT SENT TO GEMINI:")
    print(f'   "{result["privacy_protection"]["anonymized_text"]}"')
    print()
    
    print("🤖 GEMINI'S RESPONSE (sanitized):")
    print(f'   "{result["ai_response"]["sanitized_response"][:150]}..."')
    print()
    
    print("✅ FINAL RESPONSE (with your info restored):")
    print("-" * 70)
    print(result['ai_response']['final_response'])
    print("-" * 70)
    print()
    
    print("📊 SUMMARY:")
    print(f"   • Service Used: {result['ai_response']['service_used'].upper()}")
    print(f"   • Processing Time: {result['coordination_info']['processing_time']:.2f}s")
    print(f"   • Privacy Protection: {'ACTIVE' if result['privacy_protection']['detections'] else 'NOT NEEDED'}")
    print()
    
    print("✨ CONCLUSION:")
    print("   Gemini received ONLY the sanitized version.")
    print("   Your personal information (Sarah Johnson, sarah.j@email.com) was NEVER sent to Gemini.")
    print("   But your final response includes your real name and email!")
    print()

def interactive_mode():
    """Interactive mode - try your own prompts"""
    
    print("🎮 INTERACTIVE MODE")
    print("=" * 70)
    print()
    print("Try your own prompts! Enter prompts with personal information")
    print("and see how they're protected before being sent to Gemini.")
    print()
    print("Type 'quit' to exit.")
    print()
    
    coordinator = MultiAICoordinator()
    
    while True:
        try:
            prompt = input("\n💬 Your prompt: ").strip()
            
            if prompt.lower() in ['quit', 'exit', 'q']:
                print("\n👋 Goodbye!")
                break
            
            if not prompt:
                continue
            
            print("\n⚙️  Processing with privacy protection...\n")
            
            result = coordinator.process_with_coordination(
                prompt,
                preferred_service='gemini'
            )
            
            # Show sanitized version
            if result['privacy_protection']['detections']:
                print("🔒 Sanitized version sent to Gemini:")
                print(f'   "{result["privacy_protection"]["anonymized_text"]}"')
                print()
            
            # Show response
            print("🤖 Gemini Response:")
            print("-" * 70)
            print(result['ai_response']['final_response'])
            print("-" * 70)
            
        except KeyboardInterrupt:
            print("\n\n👋 Interrupted. Goodbye!")
            break
        except Exception as e:
            print(f"\n❌ Error: {e}")
            print("Make sure LM Studio is running and Gemini API key is set.")

def main():
    """Main function"""
    
    # Check for API key
    load_dotenv()
    
    if not os.getenv('GEMINI_API_KEY'):
        print("❌ ERROR: GEMINI_API_KEY not found in .env file")
        print()
        print("Please add your Gemini API key to .env:")
        print("   GEMINI_API_KEY=your_api_key_here")
        print()
        sys.exit(1)
    
    print()
    print("Choose mode:")
    print("1. Simple example (demonstrates the flow)")
    print("2. Interactive mode (try your own prompts)")
    print()
    
    choice = input("Enter choice (1 or 2): ").strip()
    print()
    
    if choice == '1':
        simple_example()
    elif choice == '2':
        interactive_mode()
    else:
        print("Invalid choice. Running simple example...")
        print()
        simple_example()

if __name__ == "__main__":
    main()
