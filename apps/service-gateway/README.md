# Service Gateway

This directory contains the Python Flask gateway and supporting privacy-analysis code.

It is the HTTP-facing wrapper for people who want to run PrivacyAI as a service instead of importing the SDK directly.

## Start

```bash
cd apps/service-gateway
pip install -r requirements.txt
python app.py
```

## Main endpoints

- `/api/process`
- `/api/sanitize`
- `/api/status`
- `/health`

