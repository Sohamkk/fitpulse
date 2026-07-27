import os
import tempfile
import app as app_module

app_module.DB_PATH = os.path.join(tempfile.gettempdir(), 'fitpulse_test.db')
app_module.init_db()
client = app_module.app.test_client()

resp = client.post('/api/auth/register', json={'email':'demo@example.com','password':'secret123','name':'Demo User'})
print('register', resp.status_code, resp.get_json())
resp2 = client.post('/api/auth/login', json={'email':'demo@example.com','password':'secret123'})
print('login', resp2.status_code, resp2.get_json())
