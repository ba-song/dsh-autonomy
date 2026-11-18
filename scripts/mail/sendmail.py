#!/usr/bin/env python3
"""Send mail via SMTP_SSL. Usage: sendmail.py <envfile> <subject> [--to addr] [--owner addr] [--in-reply-to id] [--references id]; body on stdin."""
import argparse, json, smtplib, sys
from email.message import EmailMessage
from email.utils import formataddr

def read_env(path):
    env = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env

def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument('envfile')
    ap.add_argument('subject', nargs='?', default='')
    ap.add_argument('--to', action='append', default=[])
    ap.add_argument('--owner', action='append', default=[])
    ap.add_argument('--in-reply-to', dest='in_reply_to', default=None)
    ap.add_argument('--references', dest='references', default=None)
    args = ap.parse_args()
    try:
        env = read_env(args.envfile)
        user = env.get('SMTP_USER', '')
        password = env.get('SMTP_PASS', '')
        whitelist = [x.strip().lower() for x in env.get('MAIL_TO', '').split(',') if x.strip()]
        whitelist += [x.strip().lower() for x in args.owner if x.strip()]
        to = [x.strip() for x in args.to if x.strip()] or whitelist
        to_lower = [x.lower() for x in to]
        if not user or not password or not whitelist:
            print(json.dumps({'ok': False, 'code': 'MAIL_ENV_MISSING'}, ensure_ascii=False))
            return 2
        if any(x not in whitelist for x in to_lower):
            print(json.dumps({'ok': False, 'code': 'E_NOT_OWNER'}, ensure_ascii=False))
            return 3
        body = sys.stdin.read()
        msg = EmailMessage()
        msg['From'] = formataddr(('汐', user))
        msg['To'] = ', '.join(to)
        msg['Subject'] = args.subject
        if args.in_reply_to:
            msg['In-Reply-To'] = args.in_reply_to
        if args.references:
            msg['References'] = args.references
        msg.set_content(body)
        host = 'smtp.qq.com'
        with smtplib.SMTP_SSL(host, 465, timeout=20) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
        print(json.dumps({'ok': True, 'to': to}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'code': 'MAIL_SEND_FAILED', 'error': str(e)[:300]}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    sys.exit(main())
