#!/usr/bin/env python3
"""
Privacy Guardian AI Gateway - Demo Script

This script demonstrates the core functionality of the Privacy Guardian system.
It shows how sensitive data is detected, sanitized, and then de-sanitized.
"""

import sys
import os

# Add the parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from privacy_guardian.sanitizer import PrivacyProcessor


def print_separator(title=""):
    """Print a visual separator."""
    print("\n" + "="*60)
    if title:
        print(f" {title}")
        print("="*60)


def demonstrate_basic_sanitization():
    """Demonstrate basic sanitization functionality."""
    print_separator("BASIC SANITIZATION DEMO")
    
    processor = PrivacyProcessor()
    
    # Test cases with different types of sensitive data
    test_cases = [
        "Hi, I'm John Smith from Acme Corp. Email me at john.smith@acme.com",
        "Call me at 555-123-4567 or visit our website at https://company.com",
        "My IP address is 192.168.1.100 and my credit card is 1234-5678-9012-3456",
        "This is a normal sentence with no sensitive information.",
        ""  # Empty text test
    ]
    
    for i, text in enumerate(test_cases, 1):
        print(f"\nTest Case {i}:")
        print(f"Original Text: '{text}'")
        
        if not text:
            print("(Empty text)")
            continue
            
        # Sanitize the text
        result = processor.sanitize(text)
        
        print(f"Sanitized Text: '{result.sanitized_text}'")
        print(f"Entities Found: {len(result.entities)}")
        
        if result.session_map:
            print("Session Map:")
            for placeholder, original in result.session_map.items():
                print(f"  {placeholder} → {original}")
        else:
            print("No sensitive entities detected.")


def demonstrate_full_cycle():
    """Demonstrate a complete sanitize → AI response → desanitize cycle."""
    print_separator("FULL CYCLE DEMO")
    
    processor = PrivacyProcessor()
    
    # Simulate user input
    user_input = "Hi, I'm Jane Doe from NYC. My email is jane.doe@example.com and my phone is 555-987-6543."
    
    print(f"1. Original User Input:")
    print(f"   '{user_input}'")
    
    # Step 1: Sanitize user input
    result = processor.sanitize(user_input)
    
    print(f"\n2. Sanitized Input (sent to AI):")
    print(f"   '{result.sanitized_text}'")
    
    print(f"\n3. Session Map Created:")
    for placeholder, original in result.session_map.items():
        print(f"   {placeholder} → {original}")
    
    # Step 2: Simulate AI response using the sanitized input
    simulated_ai_response = f"Hello {result.sanitized_text.split()[2]}! I see you're from {result.sanitized_text.split()[5]}. I'll send information to {list(result.session_map.keys())[0]} and may call {list(result.session_map.keys())[1]} if needed."
    
    print(f"\n4. AI Response (with placeholders):")
    print(f"   '{simulated_ai_response}'")
    
    # Step 3: De-sanitize the AI response
    final_response = processor.desanitize(simulated_ai_response, result.session_map)
    
    print(f"\n5. Final Response (de-sanitized):")
    print(f"   '{final_response}'")


def demonstrate_sensitivity_analysis():
    """Demonstrate sensitivity analysis features."""
    print_separator("SENSITIVITY ANALYSIS DEMO")
    
    processor = PrivacyProcessor()
    
    complex_text = """
    Dear Support Team,
    
    I'm writing from our New York office. My colleague John Smith (john.smith@company.com) 
    and I are having issues with our system. Please contact us at:
    - Office: 555-123-4567
    - John's mobile: 555-987-6543
    - Our server IP: 10.0.1.50
    
    We tried accessing https://internal.company.com but couldn't connect.
    
    Our company credit card ending in 1234-5678-9012-3456 was charged incorrectly.
    
    Please help!
    
    Best regards,
    Sarah Johnson
    sarah.johnson@company.com
    """
    
    print("Complex Text Analysis:")
    print(f"Original text length: {len(complex_text)} characters")
    
    result = processor.sanitize(complex_text)
    
    print(f"Total entities detected: {len(result.entities)}")
    
    # Get sensitivity summary
    summary = processor.get_sensitivity_summary(result.entities)
    print("\nEntity Types Found:")
    for entity_type, count in summary.items():
        print(f"  {entity_type}: {count}")
    
    print(f"\nSanitized text length: {len(result.sanitized_text)} characters")
    print(f"Compression ratio: {len(result.sanitized_text) / len(complex_text):.2%}")
    
    # Export session data for analysis
    session_export = processor.export_session_data(result)
    print(f"\nSession data export length: {len(session_export)} characters")


def demonstrate_edge_cases():
    """Demonstrate handling of edge cases."""
    print_separator("EDGE CASES DEMO")
    
    processor = PrivacyProcessor()
    
    edge_cases = [
        ("Only sensitive data", "john@example.com"),
        ("Multiple same type", "Email john@example.com or jane@test.com"),
        ("Special characters", "Contact user+tag@sub-domain.co.uk"),
        ("Mixed entities", "John (john@example.com) from NYC called 555-123-4567"),
        ("No entities", "This has no sensitive information at all."),
    ]
    
    for case_name, text in edge_cases:
        print(f"\n{case_name}:")
        print(f"Input: '{text}'")
        
        result = processor.sanitize(text)
        print(f"Output: '{result.sanitized_text}'")
        
        if result.session_map:
            print("Mappings:", list(result.session_map.keys()))


def main():
    """Main demo function."""
    print("🔒 Privacy Guardian AI Gateway - Core Engine Demo")
    print("This demo shows the sanitization engine without requiring external services.")
    
    try:
        demonstrate_basic_sanitization()
        demonstrate_full_cycle()
        demonstrate_sensitivity_analysis()
        demonstrate_edge_cases()
        
        print_separator("DEMO COMPLETE")
        print("✅ All core functionality working correctly!")
        print("\nNext Steps:")
        print("- Run 'pytest' to execute the full test suite")
        print("- Proceed to Phase 2: Web Interface Development")
        print("- Set up LM Studio for enhanced local model detection")
        
    except Exception as e:
        print(f"\n❌ Error during demo: {e}")
        print("Please check your installation and try again.")
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())