"""Nordic Engros – story v7: dynamisk LAYOUT (samme farger), varierer komposisjon."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
W,H=1080,1920
CREAM=(247,240,222); ORANGE=(239,120,28); PEACH=(247,201,158)
AMBER_DEEP=(224,149,31); INK=(45,45,52); MUTE=(150,140,120); WHITE=(255,255,255)
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
def logo_mark(target,w):
    src=Image.open("logo_mark.png").convert("RGB"); a=np.asarray(src).astype(int)
    al=np.clip((255-a[:,:,2])/(255-89),0,1); al=(al*255).astype('uint8')
    out=Image.new("RGBA",src.size,target+(0,)); out.putalpha(Image.fromarray(al))
    h=int(src.size[1]*w/src.size[0]); return out.resize((w,h),Image.LANCZOS)
def process_product(path):
    im=Image.open(path)
    if im.mode in ("RGBA","LA"):
        rgba=im.convert("RGBA")
        if np.asarray(rgba)[:,:,3].min()<250: return rgba.crop(rgba.getbbox())
    from scipy import ndimage
    src=im.convert("RGB"); a=np.asarray(src)
    nw=(a>236).all(axis=2); lbl,_=ndimage.label(nw)
    border=set(lbl[0,:])|set(lbl[-1,:])|set(lbl[:,0])|set(lbl[:,-1]); border.discard(0)
    bg=np.isin(lbl,list(border)); alpha=np.where(bg,0,255).astype('uint8')
    out=src.convert("RGBA"); out.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6)))
    return out.crop(out.getbbox())
def draw_frame(d):
    x0,y0,x1,y1=44,44,W-44,H-44; c=AMBER_DEEP; w=5; rTL,rTR,rBR,rBL=70,34,70,34
    d.line([(x0+rTL,y0),(x1-rTR,y0)],fill=c,width=w); d.line([(x1,y0+rTR),(x1,y1-rBR)],fill=c,width=w)
    d.line([(x1-rBR,y1),(x0+rBL,y1)],fill=c,width=w); d.line([(x0,y1-rBL),(x0,y0+rTL)],fill=c,width=w)
    d.arc([x0,y0,x0+2*rTL,y0+2*rTL],180,270,fill=c,width=w); d.arc([x1-2*rTR,y0,x1,y0+2*rTR],270,360,fill=c,width=w)
    d.arc([x1-2*rBR,y1-2*rBR,x1,y1],0,90,fill=c,width=w); d.arc([x0,y1-2*rBL,x0+2*rBL,y1],90,180,fill=c,width=w)

# hver layout: (per produkt: cx, baseline_y, target_h, vinkel), pluss sirkel (cx,cy,rx,ry), z-order
LAYOUTS={
 "fan":      {"pos":[(474,1330,580,-8),(606,1330,560,8)], "circ":(540,1045,315,300), "z":[0,1]},
 "diagonal": {"pos":[(410,1150,510,-13),(662,1360,612,9)], "circ":(548,1140,335,318), "z":[0,1]},
 "stagger":  {"pos":[(430,1430,560,-6),(660,1180,540,12)], "circ":(545,1120,330,330), "z":[1,0]},
 "hero":     {"pos":[(560,1380,730,-4)], "circ":(560,1060,335,330), "z":[0]},
}

def story(products, layout="fan", heading="UKENS NYHETER", out="story.png"):
    L=LAYOUTS[layout]; img=Image.new("RGB",(W,H),CREAM); d=ImageDraw.Draw(img)
    draw_frame(d)
    cx,cy,rx,ry=L["circ"]
    d.ellipse([cx-rx,cy-ry,cx+rx,cy+ry],fill=PEACH); d.ellipse([cx-rx+70,cy-ry+70,cx+rx-70,cy+ry-50],fill=ORANGE)
    mk=logo_mark(ORANGE,120); img.paste(mk,(W//2-mk.width//2,158),mk)
    tracked(d,W//2,300,"NORDIC",font(800,54),INK,2); tracked(d,W//2,366,"E N G R O S",font(700,31),ORANGE,5)
    tracked(d,W//2,478,heading,font(800,58),INK,1); d.rectangle([W//2-70,564,W//2+70,572],fill=ORANGE)
    n=min(len(products),len(L["pos"])); items=[]
    for i in range(n):
        pcx,base,th,ang=L["pos"][i]; p=process_product(products[i]); sc=th/p.height
        p=p.resize((max(1,int(p.width*sc)),th),Image.LANCZOS)
        if ang: p=p.rotate(-ang,expand=True,resample=Image.BICUBIC)
        items.append((p,int(pcx-p.width//2),int(base-p.height),base))
    for i in L["z"][:n]:
        p,x,y,base=items[i]; gw=int(p.width*0.86); gh=max(12,int(gw*0.14))
        s=Image.new("RGBA",(W,H),(0,0,0,0))
        ImageDraw.Draw(s).ellipse([x+p.width//2-gw//2,base-gh//2,x+p.width//2+gw//2,base+gh//2],fill=(60,40,25,80))
        sb=s.filter(ImageFilter.GaussianBlur(18)); img.paste(sb,(0,0),sb)
    for i in L["z"][:n]:
        p,x,y,base=items[i]; img.paste(p,(x,y),p)
    d=ImageDraw.Draw(img)
    by=1560; d.rounded_rectangle([110,by,W-110,by+120],radius=24,fill=ORANGE)
    tracked(d,W//2,by+22,"BESTILL I NETTBUTIKKEN",font(800,40),WHITE,2)
    d.text((W//2-d.textlength("nordicengros.no",font=font(700,32))/2,by+74),"nordicengros.no",font=font(700,32),fill=WHITE)
    d.text((W//2-d.textlength("Nye varer på lager hver uke",font=font(600,30))/2,1744),"Nye varer på lager hver uke",font=font(600,30),fill=MUTE)
    img.save(out); print("lagret",out,layout)

P=["extracted/p4_0_1024x1024.png","raff_real_cut.png"]
story(P,"fan",out="lay_fan.png")
story(P,"diagonal",out="lay_diagonal.png")
story(P,"stagger",out="lay_stagger.png")
story(["extracted/p4_0_1024x1024.png"],"hero",out="lay_hero.png")
