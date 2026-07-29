import os
import sys
sys.path.insert(0, os.getcwd())
import app

print('cwd', os.getcwd())
print('.env file exists', os.path.exists(os.path.join(app.BASE_DIR, '.env')))
print('key id from env', os.environ.get('RAZORPAY_KEY_ID'))
print('secret set?', bool(os.environ.get('RAZORPAY_KEY_SECRET')))
print('module key id', app.RAZORPAY_KEY_ID)
print('module secret set?', bool(app.RAZORPAY_KEY_SECRET))
print('razorpay package installed:', app.razorpay is not None)

client = app.get_razorpay_client()
print('client ready:', client is not None)

if client:
    try:
        order = client.order.create({"amount": 100, "currency": "INR", "receipt": "debug-check"})
        print('test order created OK:', order['id'])
    except Exception as e:
        print('order creation failed:', e)
