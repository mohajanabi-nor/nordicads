"""Nordic Engros – «100 NYE VARER» montasje-reel: rullende produktvegg + teller."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, imageio.v2 as imageio, math
W,H=1080,1920
CREAM=(247,240,222); ORANGE=(239,120,28); AMBER_DEEP=(224,149,31)
INK=(45,45,52); MUTE=(150,140,120); WHITE=(255,255,255)
FONT="fonts/Montserrat-var.ttf"; FPS=24; N=192

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
def ease(t): t=max(0,min(1,t)); return 1-(1-t)**3
def vgrad(height,top_op,bottom_op,flip=False):
    a=np.linspace(top_op,bottom_op,height).astype('uint8')
    if flip: a=a[::-1]
    arr=np.zeros((height,W,4),'uint8'); arr[:,:,0]=CREAM[0]; arr[:,:,1]=CREAM[1]; arr[:,:,2]=CREAM[2]; arr[:,:,3]=a[:,None]
    return Image.fromarray(arr,"RGBA")

paths=["extracted/p4_0_1024x1024.png","fanta_can_cut.png","fanta_bottle_cut.png","milka_wafer_cut.png",
       "milka_bubbly_cut.png","lays_salted_cut.png","lays_limon_cut.png","lowicz_cut.png","hajdu_cut.png","raff_real_cut.png"]
prods=[load_cut(p) for p in paths]

# bygg produktvegg
cols=5; cw=200; ch=232; gap=16; rows=18
wall_w=cols*cw+(cols+1)*gap; wall_h=rows*ch+(rows+1)*gap
wall=Image.new("RGBA",(wall_w,wall_h),(0,0,0,0)); idx=0
for r in range(rows):
    for c in range(cols):
        p=prods[(idx*7+3)%len(prods)]; idx+=1
        fit=min((cw-26)/p.width,(ch-26)/p.height)*(0.86+0.12*((idx*5)%4)/3)
        pp=p.resize((max(1,int(p.width*fit)),max(1,int(p.height*fit))),Image.LANCZOS)
        ang=((idx*53)%11)-5; pp=pp.rotate(ang,expand=True,resample=Image.BICUBIC)
        x=gap+c*(cw+gap)+(cw-pp.width)//2; y=gap+r*(ch+gap)+(ch-pp.height)//2
        wall.alpha_composite(pp,(x,y))
wall_x=(W-wall_w)//2

topG=vgrad(500,255,0); botG=vgrad(360,0,255)
frameL=frame_layer(); mk=logo_mark(ORANGE,86)
# CTA-lag
ctaL=Image.new("RGBA",(W,H),(0,0,0,0)); dc=ImageDraw.Draw(ctaL); by=1640
dc.rounded_rectangle([110,by,W-110,by+120],radius=24,fill=ORANGE)
tracked(dc,W//2,by+22,"BESTILL I NETTBUTIKKEN",font(800,40),WHITE,2)
dc.text((W//2-dc.textlength("nordicengros.no",font=font(700,32))/2,by+74),"nordicengros.no",font=font(700,32),fill=WHITE)

wy_start=470; wy_end=wy_start-2300
frames=[]
for f in range(N):
    img=Image.new("RGBA",(W,H),CREAM+(255,))
    prog=ease(max(0,min(1,(f-8)/(N-28))))
    wy=int(wy_start+prog*(wy_end-wy_start))
    img.alpha_composite(wall,(wall_x,wy))
    img.alpha_composite(topG,(0,0)); img.alpha_composite(botG,(0,H-360))
    d=ImageDraw.Draw(img)
    img.alpha_composite(mk,(W//2-mk.width//2,96))
    tracked(d,W//2,196,"NORDIC ENGROS",font(800,34),INK,3)
    count=int(round(100*ease(min(1,f/72.0))))
    nf=font(800,150); ntxt=str(count)
    d.text((W//2-d.textlength(ntxt,font=nf)/2,250),ntxt,font=nf,fill=ORANGE)
    tracked(d,W//2,418,"NYE VARER DENNE UKEN",font(800,38),INK,2)
    ca=ease((f-(N-32))/20.0)
    if ca>0:
        cl=ctaL.copy(); al=cl.split()[3].point(lambda v:int(v*ca)); cl.putalpha(al)
        img.alpha_composite(cl,(0,int((1-ca)*120)))
    img.alpha_composite(frameL,(0,0))
    frames.append(np.asarray(img.convert("RGB")))
imageio.mimwrite("reel_100.mp4",frames,fps=FPS,codec="libx264",quality=8,macro_block_size=8)
print("lagret reel_100.mp4",len(frames),"frames; vegg",wall_w,"x",wall_h)
