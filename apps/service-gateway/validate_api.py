#!/usr/bin/env python3
"""
Validation test for AI-friendly prompt analysis API
Run this to verify the API is working correctly
"""

import sys
import json
import subprocess
from pathlib import Path

def run_test(test_name, command, expected_checks):
    """Run a test and verify expected outcomes"""
    print(f"🧪 Testing: {test_name}")
    
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode != 0:
            print(f"   ❌ Command failed: {result.stderr}")
            return False
        
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            print(f"   ❌ Invalid JSON output")
            return False
        
        for check_name, check_func in expected_checks.items():
            if not check_func(data):
                print(f"   ❌ Failed check: {check_name}")
                return False
        
        print(f"   ✅ Passed")
        return True
        
    except subprocess.TimeoutExpired:
        print(f"   ❌ Timeout")
        return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def main():
    print("🔍 Privacy Guardian API Validation Tests")
    print("=" * 50)
    print()
    
    tests_passed = 0
    tests_total = 0
    
    # Test 1: Basic message with PII
    tests_total += 1
    if run_test(
        "Basic PII detection",
        'python3 prompt_analysis_api.py "my name is john"',
        {
            'has_metadata': lambda d: 'metadata' in d,
            'has_detections': lambda d: len(d.get('level2_ai_privacy', {}).get('detections', [])) > 0,
            'privacy_protected': lambda d: d.get('final_output', {}).get('privacy_protected') == True,
            'has_timing': lambda d: 'timing_summary' in d
        }
    ):
        tests_passed += 1
    print()
    
    # Test 2: Message without PII
    tests_total += 1
    if run_test(
        "No PII detection",
        'python3 prompt_analysis_api.py "hello world"',
        {
            'no_detections': lambda d: len(d.get('level2_ai_privacy', {}).get('detections', [])) == 0,
            'not_protected': lambda d: d.get('final_output', {}).get('privacy_protected') == False,
            'original_preserved': lambda d: d.get('final_output', {}).get('final_prompt') == 'hello world'
        }
    ):
        tests_passed += 1
    print()
    
    # Test 3: Email detection
    tests_total += 1
    if run_test(
        "Email PII detection",
        'python3 prompt_analysis_api.py "contact john@example.com"',
        {
            'has_detections': lambda d: len(d.get('level2_ai_privacy', {}).get('detections', [])) > 0,
            'email_detected': lambda d: any(
                'email' in det.get('privacy_type', '').lower() 
                for det in d.get('level2_ai_privacy', {}).get('detections', [])
            ),
        }
    ):
        tests_passed += 1
    print()
    
    # Test 4: Pretty printing works
    tests_total += 1
    if run_test(
        "Pretty print format",
        'python3 prompt_analysis_api.py --pretty "test"',
        {
            'is_valid_json': lambda d: True,  # Already parsed
            'has_structure': lambda d: all(k in d for k in ['metadata', 'final_output', 'timing_summary'])
        }
    ):
        tests_passed += 1
    print()
    
    # Test 5: Timing data present
    tests_total += 1
    if run_test(
        "Timing metrics",
        'python3 prompt_analysis_api.py "test timing"',
        {
            'has_level_times': lambda d: all(
                k in d.get('timing_summary', {}) 
                for k in ['level1_seconds', 'level2_seconds', 'level3_seconds', 'total_seconds']
            ),
            'reasonable_time': lambda d: d.get('timing_summary', {}).get('total_seconds', 999) < 5.0,
            'has_speed': lambda d: 'processing_speed_chars_per_second' in d.get('timing_summary', {})
        }
    ):
        tests_passed += 1
    print()
    
    # Test 6: Service selection
    tests_total += 1
    if run_test(
        "Service coordination",
        'python3 prompt_analysis_api.py "write python code"',
        {
            'has_service': lambda d: 'selected_service' in d.get('level3_multi_ai_coordination', {}),
            'has_scores': lambda d: 'service_scores' in d.get('level3_multi_ai_coordination', {}),
            'has_request_type': lambda d: 'request_type' in d.get('level3_multi_ai_coordination', {})
        }
    ):
        tests_passed += 1
    print()
    
    # Test 7: Batch mode (if we can create temp file)
    try:
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            f.write("test message 1\n")
            f.write("test message 2\n")
            temp_file = f.name
        
        tests_total += 1
        if run_test(
            "Batch processing",
            f'python3 prompt_analysis_api.py --batch {temp_file}',
            {
                'has_results': lambda d: 'results' in d,
                'has_total': lambda d: d.get('total_messages') == 2,
                'results_list': lambda d: len(d.get('results', [])) == 2
            }
        ):
            tests_passed += 1
        print()
        
        Path(temp_file).unlink()
    except Exception as e:
        print(f"⚠️  Skipping batch test: {e}")
        print()
    
    # Summary
    print("=" * 50)
    print(f"📊 Results: {tests_passed}/{tests_total} tests passed")
    
    if tests_passed == tests_total:
        print("✅ All tests passed! API is working correctly.")
        return 0
    else:
        print(f"❌ {tests_total - tests_passed} test(s) failed")
        return 1

if __name__ == '__main__':
    sys.exit(main())
