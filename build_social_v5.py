"""Nordic Engros – story v5 (9:16), ren cream-teaser. Tynn amber-ramme, ingen pris."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, math

W,H=1080,1920
CREAM=(247,240,222); ORANGE=(239,120,28); PEACH=(247,201,158)
PEACH_D=(241,180,128); AMBER_DEEP=(224,149,31)
INK=(45,45,52); MUTE=(150,140,120); WHITE=(255,255,255)
FONT="fonts/Montserrat-var.ttf"

def font(w,s):
    f=ImageFont.truetype(FONT,s)
    try: f.set_variation_by_axes([w])
    except: pass
    return f

def tracked(d,cx,y,t,fnt,fill,tr,left=None):
    ws=[d.textlength(c,font=fnt) for c in t]; tot=sum(ws)+tr*(len(t)-1)
    x=left if left is not None else cx-tot/2
    for c,wc in zip(t,ws): d.text((x,y),c,font=fnt,fill=fill); x+=wc+tr
    return tot

def draw_frame(d):
    x0,y0,x1,y1=44,44,W-44,H-44; col=AMBER_DEEP; wdt=5
    rTL,rTR,rBR,rBL=70,34,70,34   # litt forskjellige myke hjørner
    d.line([(x0+rTL,y0),(x1-rTR,y0)],fill=col,width=wdt)
    d.line([(x1,y0+rTR),(x1,y1-rBR)],fill=col,width=wdt)
    d.line([(x1-rBR,y1),(x0+rBL,y1)],fill=col,width=wdt)
    d.line([(x0,y1-rBL),(x0,y0+rTL)],fill=col,width=wdt)
    d.arc([x0,y0,x0+2*rTL,y0+2*rTL],180,270,fill=col,width=wdt)
    d.arc([x1-2*rTR,y0,x1,y0+2*rTR],270,360,fill=col,width=wdt)
    d.arc([x1-2*rBR,y1-2*rBR,x1,y1],0,90,fill=col,width=wdt)
    d.arc([x0,y1-2*rBL,x0+2*rBL,y1],90,180,fill=col,width=wdt)

def logo_mark(target,w):
    src=Image.open("logo_mark.png").convert("RGB"); a=np.asarray(src).astype(int)
    al=np.clip((255-a[:,:,2])/(255-89),0,1); al=(al*255).astype('uint8')
    out=Image.new("RGBA",src.size,target+(0,)); out.putalpha(Image.fromarray(al))
    h=int(src.size[1]*w/src.size[0]); return out.resize((w,h),Image.LANCZOS)

def process_product(path):
    im=Image.open(path)
    if im.mode in ("RGBA","LA"):
        rgba=im.convert("RGBA")
        if np.asarray(rgba)[:,:,3].min()<250:   # allerede klippet
            return rgba.crop(rgba.getbbox())
    from scipy import ndimage
    src=im.convert("RGB"); a=np.asarray(src)
    nw=(a>236).all(axis=2); lbl,_=ndimage.label(nw)
    border=set(lbl[0,:])|set(lbl[-1,:])|set(lbl[:,0])|set(lbl[:,-1]); border.discard(0)
    bg=np.isin(lbl,list(border)); alpha=np.where(bg,0,255).astype('uint8')
    out=src.convert("RGBA"); out.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6)))
    return out.crop(out.getbbox())

def story(products, heading="UKENS NYHETER", out="story.png"):
    img=Image.new("RGB",(W,H),CREAM); d=ImageDraw.Draw(img)
    draw_frame(d)
    # myke sirkler bak produktet
    d.ellipse([230,740,850,1340],fill=PEACH); d.ellipse([305,810,775,1270],fill=ORANGE)
    # logo
    mk=logo_mark(ORANGE,120); img.paste(mk,(W//2-mk.width//2,158),mk)
    tracked(d,W//2,300,"NORDIC",font(800,54),INK,2)
    tracked(d,W//2,366,"E N G R O S",font(700,31),ORANGE,5)
    tracked(d,W//2,478,heading,font(800,58),INK,1)
    d.rectangle([W//2-70,564,W//2+70,572],fill=ORANGE)
    # produkter
    n=min(len(products),3); cx=540; floor=1320
    if n==1: angs,scales,dxs=[0],[1.0],[0]
    elif n==2: angs,scales,dxs=[-8,8],[0.96,0.96],[-145,148]
    else: angs,scales,dxs=[-14,0,14],[0.82,1.0,0.82],[-225,0,225]
    items=[]
    for i in range(n):
        p=process_product(products[i]); th=int(580*scales[i]); sc=th/p.height
        p=p.resize((max(1,int(p.width*sc)),th),Image.LANCZOS)
        if angs[i]: p=p.rotate(-angs[i],expand=True,resample=Image.BICUBIC)
        x=int(cx+dxs[i]-p.width//2); y=int(floor-p.height); items.append((p,x,y))
    zorder=[0,2,1][:n] if n>=3 else list(range(n))
    for i in zorder:
        p,x,y=items[i]; gw=int(p.width*0.86); gh=max(12,int(gw*0.14))
        s=Image.new("RGBA",(W,H),(0,0,0,0))
        ImageDraw.Draw(s).ellipse([x+p.width//2-gw//2,floor-gh//2,x+p.width//2+gw//2,floor+gh//2],fill=(80,45,20,80))
        sb=s.filter(ImageFilter.GaussianBlur(18)); img.paste(sb,(0,0),sb)
    for i in zorder:
        p,x,y=items[i]; img.paste(p,(x,y),p)
    d=ImageDraw.Draw(img)
    # CTA
    by=1560; d.rounded_rectangle([110,by,W-110,by+120],radius=24,fill=ORANGE)
    tracked(d,W//2,by+22,"BESTILL I NETTBUTIKKEN",font(800,40),WHITE,2)
    d.text((W//2-d.textlength("nordicengros.no",font=font(700,32))/2,by+74),"nordicengros.no",font=font(700,32),fill=WHITE)
    d.text((W//2-d.textlength("Nye varer på lager hver uke",font=font(600,30))/2,1744),"Nye varer på lager hver uke",font=font(600,30),fill=MUTE)
    img.save(out); print("lagret",out)

story(["extracted/p4_0_1024x1024.png","raff_real_cut.png"],out="story_v5_duo.png")
story(["extracted/p4_0_1024x1024.png"],heading="NYHET PÅ LAGER",out="story_v5_solo.png")
