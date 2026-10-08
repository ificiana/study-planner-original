import re,sys,colorsys
FILES=['styles','feedback','pwa-install','tutorial','tutorial-polish','analytics','feedback-admin']
def parse_color(m):
    t=m.group(0)
    if t.startswith('#'):
        h=t[1:]
        if len(h)in(3,4): h=''.join(x*2 for x in h)
        r,g,b=[int(h[i:i+2],16) for i in (0,2,4)]; a=int(h[6:8],16)/255 if len(h)==8 else None
        return r,g,b,a
    nums=re.findall(r'[\d.]+%?',m.group(2)); 
    r,g,b=[float(x) for x in nums[:3]]; a=None
    if len(nums)>3: a=float(nums[3].rstrip('%'))/(100 if nums[3].endswith('%') else 1)
    return int(r),int(g),int(b),a
def hls(r,g,b): return colorsys.rgb_to_hls(r/255,g/255,b/255)
def mapc(kind,r,g,b):
    h,l,s=hls(r,g,b)
    if kind in('bg','line') and s<.12: h,s=.61,.28
    if kind=='bg':
        if l<=.55: return None
        l2=.10+(1-l)*.7; s2=s*.7 if s>=.12 else s
    elif kind=='line':
        if l<=.6: return None
        l2=.16+(1-l)*.5; s2=s*.6
    else:
        if l>.6: return None
        if s>.35 and l>=.3: l2=max(.70,1-l+.2); s2=min(s,.85)
        elif s>.35: l2=.72; s2=min(s,.85)
        else: l2=.93-l*.4; s2=s*.5
    r2,g2,b2=[round(x*255) for x in colorsys.hls_to_rgb(h,l2,s2)]
    return r2,g2,b2
COL=re.compile(r'#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|(rgba?)\(([^()]*)\)')
def mapval(kind,val):
    changed=[False]
    def f(m):
        if m.group(0).startswith('#') or m.group(1):
            r,g,b,a=parse_color(m)
            n=mapc(kind,r,g,b)
            if n is None: return m.group(0)
            changed[0]=True
            return f'rgba({n[0]},{n[1]},{n[2]},{a:.2f})' if a is not None and a<1 else '#%02x%02x%02x'%n
        return m.group(0)
    out=COL.sub(f,val)
    return out if changed[0] else None
PROPS={'color':'text','fill':'text','background':'bg','background-color':'bg','background-image':'bg','border':'line','border-color':'line','border-top':'line','border-bottom':'line','border-left':'line','border-right':'line','border-top-color':'line','border-bottom-color':'line','border-left-color':'line','border-right-color':'line','outline':'line','outline-color':'line','stroke':'line','border-inline-start':'line','border-inline-end':'line','text-decoration-color':'text','caret-color':'text'}
def split_top(s,ch):
    out=[];d=0;cur='';q=None
    for c in s:
        if q:
            cur+=c
            if c==q:q=None
            continue
        if c in '"\'': q=c;cur+=c;continue
        if c in '([': d+=1
        if c in ')]': d-=1
        if c==ch and d==0: out.append(cur);cur=''
        else: cur+=c
    out.append(cur);return out
def decls(body):
    out=[]
    for d in split_top(body,';'):
        if ':' not in d: continue
        k,v=d.split(':',1); out.append((k.strip(),v.strip()))
    return out
def strip_comments(s): return re.sub(r'/\*.*?\*/','',s,flags=re.S)
def walk(s,ctx,emit):
    i=0;n=len(s)
    while i<n:
        j=i
        while j<n and s[j] not in '{};': j+=1
        if j>=n: break
        if s[j]==';': i=j+1;continue   # @import etc
        if s[j]=='}': i=j+1;continue
        head=s[i:j].strip();d=1;k=j+1
        while k<n and d:
            if s[k]=='{':d+=1
            elif s[k]=='}':d-=1
            k+=1
        body=s[j+1:k-1]
        if head.startswith('@'):
            if re.match(r'@(media|supports)',head): walk(body,ctx+[head],emit)
            # skip keyframes, font-face, etc.
        else: emit(ctx,head,body)
        i=k
rules=[];tokens={};handled=set();base_dark={}
for f in FILES:
    for m in re.finditer(r'\[data-theme="dark"\]\s*([^{}]+)\{',open(f'src/{f}.css').read()):
        t=m.group(1)
        t=re.sub(r'^:where\((.*)\)$',r'\1',t.strip())
        for x in split_top(t,','): handled.add(x.strip())

for f in FILES:
    s=strip_comments(open(f'src/{f}.css').read())
    def emit(ctx,head,body):
        sels=split_top(head,',')
        if any('data-theme' in x for x in sels): 
            if head.strip().startswith('[data-theme="dark"]{') or head.strip()=='[data-theme="dark"]':
                for k,v in decls(body):
                    if k.startswith('--'): tokens[k]='existing'; base_dark[k]=v
            return
        if any(re.search(r'\.(print|dark)',x) for x in sels) and 'print' in ' '.join(ctx): return
        if 'print' in ' '.join(ctx): return
        if head.strip() in (':root','html'):
            for k,v in decls(body):
                if k.startswith('--') and k not in tokens or tokens.get(k)!='existing' and k.startswith('--'):
                    kind='text' if re.search(r'text|ink|muted|fg',k) else 'line' if re.search(r'line|border',k) else 'bg'
                    nv=mapval(kind,v)
                    if nv and tokens.get(k)!='existing': tokens[k]=nv
            return
        sels=[x for x in sels]
        if not sels: return
        out=[]
        for k,v in decls(body):
            kind=PROPS.get(k)
            if not kind or 'url(' in v or 'var(' in v and not COL.search(v): continue
            nv=mapval(kind,v)
            if nv: out.append(f'{k}:{nv}')
        if out:
            sel=','.join('[data-theme="dark"] '+x.strip() for x in sels)
            rules.append((ctx,f'{sel}{{{";".join(out)}}}'))
    walk(s,[],emit)
out=['/* Generated dark-theme overrides for hard-coded light colours. Regenerate with scripts/gen-dark-css.py */']
tk=';'.join(f'{k}:{v}' for k,v in {**{k:v for k,v in tokens.items() if v!='existing'},**base_dark}.items())
if tk: out.append(f'[data-theme="dark"]{{{tk}}}')
cur=None;buf=[]
def flush():
    global buf
    if buf: 
        if cur: out.append(f'{cur}{{'+''.join(buf)+'}')
        else: out.extend(buf)
    buf=[]
for ctx,r in rules:
    c='{'.join(ctx) if False else (ctx[-1] if ctx else None)
    if len(ctx)>1: c=ctx[-1]  # nested media: flatten (rare)
    if c!=cur: flush();cur=c
    buf.append(r)
flush()
import os
fix=open('scripts/dark-fixes.css').read() if os.path.exists('scripts/dark-fixes.css') else ''
open('src/dark.css','w').write('\n'.join(out)+'\n'+fix)
print(len(rules),'rules',len(tokens),'tokens')
