# Gunicorn configuration for production deployment
# Save as gunicorn.conf.py

import os
import multiprocessing

# Server socket
bind = f"0.0.0.0:{os.getenv('FLASK_PORT', 5000)}"
backlog = 2048

# Worker processes
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = 'sync'
worker_connections = 1000
timeout = 30
keepalive = 2

# Logging
accesslog = os.getenv('ACCESS_LOG_FILE', 'access.log')
errorlog = os.getenv('ERROR_LOG_FILE', 'error.log')  
loglevel = os.getenv('LOG_LEVEL', 'info')
access_log_format = '%({x-forwarded-for}i)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)s'

# Process naming
proc_name = 'privacy-guardian-gateway'

# Server mechanics
daemon = False
pidfile = '/tmp/privacy-guardian-gateway.pid'
user = None
group = None
tmp_upload_dir = None

# SSL (for HTTPS)
keyfile = os.getenv('SSL_KEYFILE')
certfile = os.getenv('SSL_CERTFILE')

# Security
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

# Application preloading
preload_app = True

def when_ready(server):
    server.log.info("Privacy Guardian Gateway is ready to serve requests")

def worker_int(worker):
    worker.log.info("Worker received INT or QUIT signal")

def pre_fork(server, worker):
    server.log.info("Worker spawned (pid: %s)", worker.pid)

def post_fork(server, worker):
    server.log.info("Worker spawned (pid: %s)", worker.pid)