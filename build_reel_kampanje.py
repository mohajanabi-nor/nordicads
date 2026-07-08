"""Nordic Engros – KAMPANJE/TILBUD-reel (manuell): pris + rabatt, animert."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, imageio.v2 as imageio, math
W,H=1080,1920
CREAM=(247,240,222); ORANGE=(239,120,28); PEACH=(247,201,158)
AMBER_DEEP=(224,149,31); AMBER=(254,189,89); YELLOW=(253,234,43)
INK=(45,45,52); MUTE=(150,140,120); WHITE=(255,255,255)
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
def load_cut(path):
    im=Image.open(path)
    if im.mode in ("RGBA","LA","P"):
        rgba=im.convert("RGBA")
        if np.asarray(rgba)[:,:,3].min()<250: return rgba.crop(rgba.getbbox())
        bg=Image.new("RGBA",rgba.size,(255,255,255,255)); bg.alpha_composite(rgba); im=bg.convert("RGB")
    else: im=im.convert("RGB")
    from scipy import ndimage
    a=np.asarray(im); nw=(a>240).all(axis=2); lbl,_=ndimage.label(nw)
    border=set(lbl[0,:])|set(lbl[-1,:])|set(lbl[:,0])|set(lbl[:,-1]); border.discard(0)
    bg=np.isin(lbl,list(border)); alpha=np.where(bg,0,255).astype('uint8')
    out=im.convert("RGBA"); out.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6)))
    return out.crop(out.getbbox())
def prep(path,th,ang):
    p=load_cut(path); sc=th/p.height; p=p.resize((max(1,int(p.width*sc)),th),Image.LANCZOS)
    if ang: p=p.rotate(-ang,expand=True,resample=Image.BICUBIC)
    return p
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

def build(specs, new_price, old_price, out):
    pct=round((1-new_price/old_price)*100)
    base=Image.new("RGBA",(W,H),CREAM+(255,)); d=ImageDraw.Draw(base)
    d.ellipse([235,690,845,1300],fill=PEACH); d.ellipse([310,760,770,1230],fill=ORANGE)
    base.alpha_composite(frame_layer())
    logoL=Image.new("RGBA",(W,H),(0,0,0,0)); mk=logo_mark(ORANGE,118); logoL.alpha_composite(mk,(W//2-mk.width//2,150))
    dl=ImageDraw.Draw(logoL); tracked(dl,W//2,290,"NORDIC",font(800,52),INK,2); tracked(dl,W//2,354,"E N G R O S",font(700,30),ORANGE,5)
    headL=Image.new("RGBA",(W,H),(0,0,0,0)); dh=ImageDraw.Draw(headL)
    tracked(dh,W//2,462,"TILBUD",font(800,64),INK,2); dh.rectangle([W//2-74,560,W//2+74,569],fill=ORANGE)
    # sticker -X%
    stickL=Image.new("RGBA",(W,H),(0,0,0,0)); ds=ImageDraw.Draw(stickL); sx,sy,r=842,640,96
    ds.ellipse([sx-r,sy-r,sx+r,sy+r],fill=ORANGE); st=f"-{pct}%"; sf=font(800,48)
    ds.text((sx-ds.textlength(st,font=sf)/2,sy-32),st,font=sf,fill=WHITE)
    stickC=stickL.crop((sx-r-4,sy-r-4,sx+r+4,sy+r+4)); stick_pos=(sx-r-4,sy-r-4)
    # pris-blokk
    priceL=Image.new("RGBA",(W,H),(0,0,0,0)); dp=ImageDraw.Draw(priceL)
    pt=f"kr {new_price:.2f}".replace("."," ,").replace(" ,",",")
    dp.text((W//2-dp.textlength(pt,font=font(800,120))/2,1330),pt,font=font(800,120),fill=AMBER_DEEP)
    ot=f"før kr {old_price:.2f}".replace(".",",")
    ow=dp.textlength(ot,font=font(600,46)); ox=W//2-ow/2
    dp.text((ox,1486),ot,font=font(600,46),fill=MUTE); dp.line([(ox,1512),(ox+ow,1508)],fill=MUTE,width=4)
    ctaL=Image.new("RGBA",(W,H),(0,0,0,0)); dc=ImageDraw.Draw(ctaL); by=1600
    dc.rounded_rectangle([110,by,W-110,by+120],radius=24,fill=ORANGE)
    tracked(dc,W//2,by+22,"BESTILL NÅ",font(800,46),WHITE,2)
    dc.text((W//2-dc.textlength("nordicengros.no",font=font(700,32))/2,by+76),"nordicengros.no",font=font(700,32),fill=WHITE)
    frames=[]
    for f in range(N):
        img=base.copy()
        paste_a(img,logoL,(0,0),ease(f/12)); paste_a(img,headL,(0,0),ease((f-6)/14))
        for prod,cx,base_y,st0,ph,sh in specs:
            t=(f-st0)/24.0; e=ease(t); a=e
            if a<=0: continue
            entr=(1-e)*210; fl=7*math.sin(2*math.pi*(f-st0)/64.0+ph) if e>=1 else 0
            x=int(cx-prod.width//2); y=int(base_y-prod.height+entr-fl)
            shl=shadow(cx,int(base_y),prod.width); paste_a(img,shl,(0,0),a*0.9); paste_a(img,prod,(x,y),a)
        ts=(f-40)/16.0
        if ts>0:
            s=max(0.05,popscale(ts)); sc2=stickC.resize((int(stickC.width*s),int(stickC.height*s)))
            cx0=stick_pos[0]+stickC.width//2; cy0=stick_pos[1]+stickC.height//2
            paste_a(img,sc2,(cx0-sc2.width//2,cy0-sc2.height//2),ease((f-40)/10.0))
        paste_a(img,priceL,(0,0),ease((f-50)/14))
        paste_a(img,ctaL,(0,int((1-ease((f-62)/16))*150)),ease((f-62)/16))
        frames.append(np.asarray(img.convert("RGB")))
    imageio.mimwrite(out,frames,fps=FPS,codec="libx264",quality=8,macro_block_size=8); print("lagret",out,f"-{pct}%")

bottle=prep("fanta_bottle.webp",560,-7); can=prep("fanta_can.jpg",470,8)
specs=[(bottle,448,1240,10,0.0,False),(can,636,1240,22,math.pi,False)]
build(specs, 14.90, 19.90, "reel_kampanje.mp4")
