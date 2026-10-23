import json, urllib.request, urllib.error
BASE='https://tanuki-shop-preview-pr6.sashh4051.workers.dev'
checks=[('/api/health',None,200),('/api/products',None,200),('/api/customer/me',None,401),('/api/customer/wallet',None,401),('/api/admin/orders',None,401),('/api/unknown',None,404),('/api/customer/register',{'name':'QA','email':'qa-cloud@example.invalid','password':'test-password-2026'},503),('/api/customer/forgot',{'email':'qa-cloud@example.invalid'},503),('/api/customer/login',{'email':'missing@example.invalid','password':'wrong-password'},401),('/api/orders',{'items':[]},400)]
import subprocess
for path,body,expected in checks:
    args=['curl','--max-time','30','-sS','-w','\n%{http_code}',BASE+path,'-H','Content-Type: application/json','-H','Origin: '+BASE,'-H','X-Tanuki-Request: 1']
    if body is not None: args+=['--data-binary',json.dumps(body)]
    output=subprocess.check_output(args,text=True)
    payload,status=output.rsplit('\n',1)
    assert int(status)==expected,(path,status,payload[:200])
    data=json.loads(payload)
    print('PASS',path,status,flush=True)
print('PASS: 10 Preview API checks; registration/reset delivery correctly blocked without test bot')
