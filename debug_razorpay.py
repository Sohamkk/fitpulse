import os
import sys
sys.path.insert(0, os.getcwd())
import app
print('cwd', os.getcwd())
print('env file exists', os.path.exists(os.path.join(app.BASE_DIR, '.env')))
print('key id from env', os.environ.get('RAZORPAY_KEY_ID'))
print('secret from env', os.environ.get('RAZORPAY_KEY_SECRET'))
print('module vars', app.RAZORPAY_KEY_ID, app.RAZORPAY_KEY_SECRET)
print('config fn', app.get_razorpay_config())
print('razorpay module', app.razorpay)
