#!/usr/bin/env python3
"""
Privacy Guardian Prompt Analysis API
Provides programmatic access to prompt analysis for AI testing and automation
"""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from privacy_terminal import PrivacyTerminal

def analyze_prompt(message, json_output=True):
    """
    Analyze a prompt through all privacy filter levels
    
    Args:
        message: The message to analyze
        json_output: If True, return JSON data; if False, print human-readable format
    
    Returns:
        dict: Structured analysis results (if json_output=True)
    """
    terminal = PrivacyTerminal()
    return terminal._detailed_prompt_analysis(message, json_output=json_output)

def main():
    parser = argparse.ArgumentParser(
        description='Privacy Guardian Prompt Analysis API - AI-friendly testing interface',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze a single message (JSON output)
  python3 prompt_analysis_api.py "my name is john"
  
  # Analyze with pretty-printed JSON
  python3 prompt_analysis_api.py --pretty "my name is john"
  
  # Analyze from stdin
  echo "test message" | python3 prompt_analysis_api.py --stdin
  
  # Human-readable output
  python3 prompt_analysis_api.py --human "my name is john"
  
  # Batch analysis from file (one message per line)
  python3 prompt_analysis_api.py --batch messages.txt
        """
    )
    
    parser.add_argument('message', nargs='?', help='Message to analyze')
    parser.add_argument('--json', action='store_true', help='Output JSON format (default)')
    parser.add_argument('--pretty', action='store_true', help='Pretty-print JSON output')
    parser.add_argument('--human', action='store_true', help='Human-readable output')
    parser.add_argument('--stdin', action='store_true', help='Read message from stdin')
    parser.add_argument('--batch', metavar='FILE', help='Analyze messages from file (one per line)')
    parser.add_argument('--output', '-o', metavar='FILE', help='Write results to file')
    
    args = parser.parse_args()
    
    if args.batch:
        batch_analysis(args.batch, args.output, args.pretty)
    elif args.stdin:
        message = sys.stdin.read().strip()
        if message:
            result = analyze_prompt(message, json_output=not args.human)
            output_result(result, args.output, args.pretty or args.json)
    elif args.message:
        result = analyze_prompt(args.message, json_output=not args.human)
        output_result(result, args.output, args.pretty or args.json)
    else:
        parser.print_help()
        sys.exit(1)

def batch_analysis(input_file, output_file=None, pretty=False):
    """Analyze multiple messages from a file"""
    try:
        with open(input_file, 'r') as f:
            messages = [line.strip() for line in f if line.strip()]
        
        results = []
        for i, message in enumerate(messages, 1):
            print(f"Analyzing message {i}/{len(messages)}...", file=sys.stderr)
            result = analyze_prompt(message, json_output=True)
            results.append(result)
        
        batch_result = {
            'total_messages': len(messages),
            'results': results
        }
        
        output_result(batch_result, output_file, pretty)
        
    except FileNotFoundError:
        print(f"Error: File '{input_file}' not found", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error processing batch: {e}", file=sys.stderr)
        sys.exit(1)

def output_result(result, output_file=None, pretty=False):
    """Output analysis result to file or stdout"""
    if isinstance(result, dict):
        if pretty:
            output = json.dumps(result, indent=2, ensure_ascii=False)
        else:
            output = json.dumps(result, ensure_ascii=False)
    else:
        output = str(result)
    
    if output_file:
        with open(output_file, 'w') as f:
            f.write(output)
        print(f"Results written to {output_file}", file=sys.stderr)
    else:
        print(output)

if __name__ == '__main__':
    main()
