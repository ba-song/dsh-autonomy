#!/usr/bin/env python3
"""Poll IMAP (UID > cursor), output JSON lines. Does NOT mark messages read."""
import email, imaplib, json, os, sys, datetime
from email.header import decode_header, make_header
from html.parser import HTMLParser

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

class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out = []
    def handle_data(self, data):
        if data.strip():
            self.out.append(data.strip())

def html_to_text(s):
    p = TextHTML()
    try:
        p.feed(s)
        return '\n'.join(p.out)
    except Exception:
        return s

def decode_header_value(v):
    try:
        return str(make_header(decode_header(v or '')))
    except Exception:
        return v or ''

def part_text(part):
    ctype = part.get_content_type()
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        return ''
    if payload is None:
        return ''
    charset = part.get_content_charset() or 'utf-8'
    try:
        text = payload.decode(charset, errors='replace')
    except Exception:
        text = payload.decode('utf-8', errors='replace')
    return html_to_text(text) if ctype == 'text/html' else text

DANGER_EXT = {'.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.js', '.ps1', '.vbs', '.jar', '.dll', '.scr', '.pif'}
MAX_ATTACHMENTS = 5
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024

def attachment_name(part):
    fn = part.get_filename() or ''
    try:
        return str(make_header(decode_header(fn)))
    except Exception:
        return fn

def save_attachments(msg, uid, base_dir):
    out = []
    total = 0
    if not msg.is_multipart():
        return out
    for part in msg.walk():
        disp = (part.get('Content-Disposition') or '').lower()
        if 'attachment' not in disp:
            continue
        if len(out) >= MAX_ATTACHMENTS:
            out.append({'skipped': 'max_count', 'name': attachment_name(part)})
            continue
        try:
            payload = part.get_payload(decode=True) or b''
        except Exception:
            payload = b''
        size = len(payload)
        if size > MAX_FILE_BYTES:
            out.append({'skipped': 'max_file', 'name': attachment_name(part), 'size': size})
            continue
        if total + size > MAX_TOTAL_BYTES:
            out.append({'skipped': 'max_total', 'name': attachment_name(part), 'size': size})
            continue
        name = attachment_name(part) or 'attachment'
        ext = os.path.splitext(name)[1].lower()
        if not ext:
            ext = '.bin'
        day = datetime.datetime.now().strftime('%Y-%m-%d')
        directory = os.path.join(base_dir, day)
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            path = os.path.join(directory, f'{uid}-{len([x for x in out if x.get("path")]) + 1}{ext}')
            with open(path, 'wb') as f:
                f.write(payload)
            total += size
            out.append({'name': name, 'path': path, 'size': size, 'dangerous': ext in DANGER_EXT, 'ext': ext})
        except Exception as e:
            out.append({'skipped': 'save_failed', 'name': name, 'error': str(e)[:120]})
    return out

def extract(msg):
    text = ''
    attachments = 0
    if msg.is_multipart():
        for part in msg.walk():
            disp = (part.get('Content-Disposition') or '').lower()
            if 'attachment' in disp:
                attachments += 1
                continue
            if part.get_content_maintype() == 'multipart':
                continue
            if part.get_content_type() in ('text/plain', 'text/html'):
                t = part_text(part)
                if t and not text:
                    text = t
    else:
        text = part_text(msg)
    return text, attachments

def main():
    envfile = sys.argv[1]
    attachment_dir = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('DSHA_EMAIL_ATTACH_DIR', '/sdcard/DSHA/渠道/email/附件')
    cursor = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    try:
        env = read_env(envfile)
        user = env.get('SMTP_USER', '')
        password = env.get('SMTP_PASS', '')
        if not user or not password:
            print(json.dumps({'ok': False, 'code': 'MAIL_ENV_MISSING'}, ensure_ascii=False))
            return 2
        with imaplib.IMAP4_SSL('imap.qq.com', 993, timeout=20) as imap:
            imap.login(user, password)
            imap.select('INBOX', readonly=True)
            typ, data = imap.uid('SEARCH', None, 'UID', f'{cursor + 1}:*')
            uids = []
            if typ == 'OK' and data and data[0]:
                for raw in data[0].split():
                    try:
                        uid = int(raw)
                    except Exception:
                        continue
                    if uid > cursor:
                        uids.append(uid)
            for uid in sorted(uids):
                typ, data = imap.uid('FETCH', str(uid), '(RFC822)')
                if typ != 'OK' or not data or not isinstance(data[0], tuple):
                    continue
                msg = email.message_from_bytes(data[0][1])
                text, attachment_count = extract(msg)
                saved = save_attachments(msg, uid, attachment_dir)
                out = {
                    'uid': uid,
                    'from': decode_header_value(msg.get('From')),
                    'to': decode_header_value(msg.get('To')),
                    'subject': decode_header_value(msg.get('Subject')),
                    'date': msg.get('Date'),
                    'text': text,
                    'hasAttachments': attachment_count > 0,
                    'attachmentCount': attachment_count,
                    'attachments': saved,
                    'messageId': f'email:{uid}',
                }
                print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'code': 'MAIL_POLL_FAILED', 'error': str(e)[:300]}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    sys.exit(main())
