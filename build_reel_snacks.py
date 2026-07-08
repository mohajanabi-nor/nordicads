"""Nordic Engros – SNACKS kategori-reel: 3 highlights (fan) + FRA POLEN-flagg."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, imageio.v2 as imageio, math
W,H=1080,1920
CREAM=(247,240,222); ORANGE=(239,120,28); PEACH=(247,201,158)
AMBER_DEEP=(224,149,31); INK=(45,45,52); MUTE=(150,140,120); WHITE=(255,255,255)
FONT="fonts/Montserrat-var.ttf"; FPS=24; N=120
def font(w,s):
    f=ImageFont.truetype(FONT,s)
    try: f.set_variation_by_axes([w])
    except: pass
    return f
def tracked(d,cx,y,t,fnt,fill,tr):
    ws=[d.textlength(c,font=fnt) for c in t]; tot=sum(ws)+tr*(len(t)-1); x=cx-tot/2
    for c,wc in zip(t,ws): d.text((x,y),c,font=fnt,fill=fill); x+=wc+tr
def logo_mark(target,w):
    src=Image.open("logo_mark.png").convert("RGB"); a=np.asarray(src).astype(int)
    al=np.clip((255-a[:,:,2])/(255-89),0,1); al=(al*255).astype('uint8')
    out=Image.new("RGBA",src.size,target+(0,)); out.putalpha(Image.fromarray(al))
    h=int(src.size[1]*w/src.size[0]); return out.resize((w,h),Image.LANCZOS)
def frame_layer():
    L=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(L)
    x0,y0,x1,y1=44,44,W-44,H-44; c=AMBER_DEEP+(255,); w=5; rTL,rTR,rBR,rBL=70,34,70,34
    d.line([(x0+rTL,y0),(x1-rTR,y0)],fill=c,width=w); d.line([(x1,y0+rTR),(x1,y1-rBR)],fill=c,width=w)
    d.line([(x1-rBR,y1),(x0+rBL,y1)],fill=c,width=w); d.line([(x0,y1-rBL),(x0,y0+rTL)],fill=c,width=w)
    d.arc([x0,y0,x0+2*rTL,y0+2*rTL],180,270,fill=c,width=w); d.arc([x1-2*rTR,y0,x1,y0+2*rTR],270,360,fill=c,width=w)
    d.arc([x1-2*rBR,y1-2*rBR,x1,y1],0,90,fill=c,width=w); d.arc([x0,y1-2*rBL,x0+2*rBL,y1],90,180,fill=c,width=w)
    return L
def load_cut(path,thr=240):
    im=Image.open(path)
    if im.mode in ("RGBA","LA","P"):
        rgba=im.convert("RGBA")
        if np.asarray(rgba)[:,:,3].min()<250: return rgba.crop(rgba.getbbox())
        bg=Image.new("RGBA",rgba.size,(255,255,255,255)); bg.alpha_composite(rgba); im=bg.convert("RGB")
    else: im=im.convert("RGB")
    from scipy import ndimage
    a=np.asarray(im); nw=(a>thr).all(axis=2); lbl,_=ndimage.label(nw)
    border=set(lbl[0,:])|set(lbl[-1,:])|set(lbl[:,0])|set(lbl[:,-1]); border.discard(0)
    bg=np.isin(lbl,list(border)); alpha=np.where(bg,0,255).astype('uint8')
    out=im.convert("RGBA"); out.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6)))
    return out.crop(out.getbbox())
def prep(path,th,ang):
    p=load_cut(path); sc=th/p.height; p=p.resize((max(1,int(p.width*sc)),th),Image.LANCZOS)
    if ang: p=p.rotate(-ang,expand=True,resample=Image.BICUBIC)
    return p
def shine(prod,p):
    arr=np.asarray(prod).astype(float); h,w=arr.shape[:2]
    xx,yy=np.meshgrid(np.arange(w),np.arange(h)); diag=xx*0.94+yy*0.34
    span=w*0.94+h*0.34; center=(-0.25+1.5*p)*span; sigma=0.09*span
    band=np.exp(-((diag-center)**2)/(2*sigma**2)); a=arr[:,:,3:4]/255.0
    rgb=arr[:,:,:3]+(255-arr[:,:,:3])*(band[...,None]*0.6*a)
    return Image.fromarray(np.dstack([np.clip(rgb,0,255),arr[:,:,3]]).astype('uint8'),"RGBA")
def paste_a(base,layer,xy,a):
    if a<=0: return
    if a>=1: base.alpha_composite(layer,xy); return
    l=layer.copy(); al=l.split()[3].point(lambda v:int(v*a)); l.putalpha(al); base.alpha_composite(l,xy)
def ease(t): t=max(0,min(1,t)); return 1-(1-t)**3
def popscale(t): t=max(0,min(1,t)); c1=1.70158; c3=c1+1; return 1+c3*(t-1)**3+c1*(t-1)**2
def shadow(cx,base,w):
    gw=int(w*0.86); gh=max(12,int(gw*0.14)); s=Image.new("RGBA",(W,H),(0,0,0,0))
    ImageDraw.Draw(s).ellipse([cx-gw//2,base-gh//2,cx+gw//2,base+gh//2],fill=(60,40,25,80))
    return s.filter(ImageFilter.GaussianBlur(18))
def flag_pl(h):
    w=int(h*1.5); f=Image.new("RGBA",(w,h),(255,255,255,255)); d=ImageDraw.Draw(f)
    d.rectangle([0,0,w,h//2],fill=(255,255,255,255)); d.rectangle([0,h//2,w,h],fill=(220,20,60,255))
    m=Image.new("L",(w,h),0); ImageDraw.Draw(m).rounded_rectangle([0,0,w,h],radius=5,fill=255); f.putalpha(m); return f
def chip_layer(text,flag):
    fh=40; tf=font(800,30); pad=24
    tw=ImageDraw.Draw(Image.new("RGB",(4,4))).textlength(text,font=tf)
    w=int(pad+flag.width+14+tw+pad); h=fh+28
    L=Image.new("RGBA",(w,h),(0,0,0,0)); d=ImageDraw.Draw(L)
    d.rounded_rectangle([0,0,w-1,h-1],radius=h//2,fill=(255,255,255,255),outline=AMBER_DEEP+(255,),width=3)
    L.alpha_composite(flag,(pad,(h-fh)//2)); d.text((pad+flag.width+14,(h-30)//2-1),text,font=tf,fill=INK)
    return L

def build(specs, heading, out, chip=None):
    base=Image.new("RGBA",(W,H),CREAM+(255,)); d=ImageDraw.Draw(base)
    d.ellipse([225,745,865,1375],fill=PEACH); d.ellipse([300,815,790,1305],fill=ORANGE)
    base.alpha_composite(frame_layer())
    logoL=Image.new("RGBA",(W,H),(0,0,0,0)); mk=logo_mark(ORANGE,120); logoL.alpha_composite(mk,(W//2-mk.width//2,158))
    dl=ImageDraw.Draw(logoL); tracked(dl,W//2,300,"NORDIC",font(800,54),INK,2); tracked(dl,W//2,366,"E N G R O S",font(700,31),ORANGE,5)
    headL=Image.new("RGBA",(W,H),(0,0,0,0)); dh=ImageDraw.Draw(headL)
    tracked(dh,W//2,478,heading,font(800,58),INK,1); dh.rectangle([W//2-70,564,W//2+70,572],fill=ORANGE)
    ctaL=Image.new("RGBA",(W,H),(0,0,0,0)); dc=ImageDraw.Draw(ctaL); by=1600
    dc.rounded_rectangle([110,by,W-110,by+120],radius=24,fill=ORANGE)
    tracked(dc,W//2,by+22,"BESTILL I NETTBUTIKKEN",font(800,40),WHITE,2)
    dc.text((W//2-dc.textlength("nordicengros.no",font=font(700,32))/2,by+74),"nordicengros.no",font=font(700,32),fill=WHITE)
    subL=Image.new("RGBA",(W,H),(0,0,0,0)); ds=ImageDraw.Draw(subL)
    ds.text((W//2-ds.textlength("Nye varer på lager hver uke",font=font(600,30))/2,1784),"Nye varer på lager hver uke",font=font(600,30),fill=MUTE)
    chipL=chip_layer(chip[0],chip[4]) if chip else None
    frames=[]
    for f in range(N):
        img=base.copy()
        paste_a(img,logoL,(0,0),ease(f/12)); paste_a(img,headL,(0,0),ease((f-6)/14))
        for prod,cx,base_y,st,ph,sh in specs:
            t=(f-st)/24.0; e=ease(t); a=e
            if a<=0: continue
            entr=(1-e)*220; fl=7*math.sin(2*math.pi*(f-st)/64.0+ph) if e>=1 else 0
            yoff=entr-fl; pim=shine(prod,(f-50)/30.0) if (sh and 50<=f<=80) else prod
            x=int(cx-prod.width//2); y=int(base_y-prod.height+yoff)
            shl=shadow(cx,int(base_y),prod.width); paste_a(img,shl,(0,0),a*0.9); paste_a(img,pim,(x,y),a)
        if chipL is not None:
            cs=chip[3]; t=(f-cs)/16.0
            if t>0:
                s=max(0.05,popscale(t)); cc=chipL.resize((int(chipL.width*s),int(chipL.height*s)))
                paste_a(img,cc,(chip[1]-cc.width//2,chip[2]-cc.height//2),ease((f-cs)/10.0))
        paste_a(img,ctaL,(0,int((1-ease((f-56)/16))*150)),ease((f-56)/16))
        paste_a(img,subL,(0,0),ease((f-68)/14))
        frames.append(np.asarray(img.convert("RGB")))
    imageio.mimwrite(out,frames,fps=FPS,codec="libx264",quality=8,macro_block_size=8); print("lagret",out)

limon=prep("lays_limon_cut.png",470,-12)
cheet=prep("extracted/p4_0_1024x1024.png",565,0)
salted=prep("lays_salted_cut.png",470,12)
specs=[(limon,402,1330,10,0.0,False),(salted,688,1330,26,math.pi,False),(cheet,545,1360,18,math.pi/2,True)]
build(specs,"UKENS SNACKS","reel_snacks.mp4",chip=("FRA POLEN",300,720,44,flag_pl(40)))
