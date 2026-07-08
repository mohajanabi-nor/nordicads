"""Nordic Engros – NYHETER katalog, full rebuild i brand-palett.
Forside + kontakt: #282A36 + #F0781C. Mellomsider + produktsider: cream #F7F0DE.
A4 @ 150 DPI = 1240x1754. Montserrat på alt.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import qrcode, io, math, barcode, numpy as np
from barcode.writer import ImageWriter

W, H = 1240, 1754
DARK    = (40, 42, 54)      # #282A36
DARK_LITE = (50, 52, 66)
CREAM   = (247, 240, 222)   # #F7F0DE
CREAM_T = (239, 232, 214)   # svak tekstur på cream
ORANGE  = (240, 120, 28)    # gammel (fases ut)
AMBER     = (254, 189, 89)  # #FEBD59 – logofarge, brukes på mørk bg + logo
AMBER_DEEP= (224, 149, 31)  # #E0951F – samme hue, dypere, for tekst på lyse flater
ORANGE_HI = (248, 154, 77)
ORANGE_LO = (200, 92, 12)
INK     = (40, 42, 54)      # mørk tekst
MUTE_D  = (150, 153, 170)   # dempet på mørk bg
MUTE_L  = (138, 141, 148)   # dempet på cream
WHITE   = (255, 255, 255)
FONT = "fonts/Montserrat-var.ttf"
WEEK = "Uke 23 · 2026"

def font(weight, size):
    f = ImageFont.truetype(FONT, size)
    try: f.set_variation_by_axes([weight])
    except Exception: pass
    return f

def tracked(draw, cx, y, text, fnt, fill, tracking, left=None):
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking*(len(text)-1)
    x = left if left is not None else cx - total/2
    for ch, wch in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill); x += wch + tracking
    return total

def make_v(size=150, stroke=34):
    s = size
    grad = Image.new("RGB", (s, s))
    px = grad.load()
    for x in range(s):
        t = x/(s-1)
        col = tuple(int(ORANGE_HI[i]*(1-t)+ORANGE_LO[i]*t) for i in range(3))
        for y in range(s): px[x, y] = col
    mask = Image.new("L", (s, s), 0); md = ImageDraw.Draw(mask)
    pad = 6
    md.line([(pad, pad), (s//2, s-pad)], fill=255, width=stroke, joint="curve")
    md.line([(s//2, s-pad), (s-pad, pad)], fill=255, width=stroke, joint="curve")
    out = Image.new("RGBA", (s, s), (0,0,0,0)); out.paste(grad, (0,0), mask)
    return out

def faint_circles(img, color, cx, cy, rings, alpha=22):
    lay = Image.new("L", (W, H), 0); ld = ImageDraw.Draw(lay)
    for r in rings:
        ld.ellipse([cx-r, cy-r, cx+r, cy+r], outline=alpha, width=2)
    lay = lay.filter(ImageFilter.GaussianBlur(1))
    tint = Image.new("RGB", (W, H), color)
    img.paste(tint, (0,0), lay)

def make_qr(url, size):
    qr = qrcode.QRCode(border=1, box_size=10); qr.add_data(url); qr.make(fit=True)
    q = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    return q.resize((size, size), Image.NEAREST)

def logo_mark(target, w):
    """Henter ut fjell-sol-logoen fra hvit bakgrunn og omfarger til target."""
    import numpy as np
    src = Image.open("logo_mark.png").convert("RGB")
    a = np.asarray(src).astype(int)
    # alpha fra blåkanal: hvit(B=255)->0, amber(B~89)->255
    alpha = np.clip((255 - a[:,:,2]) / (255 - 89), 0, 1)
    alpha = (alpha*255).astype("uint8")
    out = Image.new("RGBA", src.size, target+(0,))
    out.putalpha(Image.fromarray(alpha))
    h = int(src.size[1]*w/src.size[0])
    return out.resize((w, h), Image.LANCZOS)

# ---------------- FORSIDE ----------------
def _star(fd,sx,sy,r,fill,rot=-math.pi/2):
    pts=[]
    for i in range(10):
        ang=rot+i*math.pi/5; rad=r if i%2==0 else r*0.40
        pts.append((sx+rad*math.cos(ang),sy+rad*math.sin(ang)))
    fd.polygon(pts,fill=fill)

# ---- region-motor for forside-etikett ----
BALKAN={"RS","HR","SI","BA","MK","AL","ME","XK","BG"}
OST_EUROPA=BALKAN|{"PL","UA","LV","LT","EE","CZ","SK","HU","RO","BY","RU","MD"}
SOR_EUROPA={"IT","ES","PT","GR","MT"}
VEST_EUROPA={"DE","NL","FR","BE","LU","AT","CH","IE","GB"}
NORDEN={"NO","SE","DK","FI","IS"}
ASIA={"CN","TH","VN","IN","JP","KR","ID","MY","PH","PK","BD"}
MIDTOSTEN={"TR","LB","SY","IL","JO","SA","AE","IR","IQ"}
EUROPA=OST_EUROPA|SOR_EUROPA|VEST_EUROPA|NORDEN|{"TR"}
REGION_ORDER=[(BALKAN,"BALKAN"),(NORDEN,"NORDEN"),(SOR_EUROPA,"SØR-EUROPA"),
              (VEST_EUROPA,"VEST-EUROPA"),(OST_EUROPA,"ØST-EUROPA"),
              (ASIA,"ASIA"),(MIDTOSTEN,"MIDTØSTEN")]
NAME={"PL":"POLEN","DE":"TYSKLAND","NL":"NEDERLAND","RS":"SERBIA","HR":"KROATIA",
      "SI":"SLOVENIA","IT":"ITALIA","TR":"TYRKIA","UA":"UKRAINA","LV":"LATVIA",
      "LT":"LITAUEN","EE":"ESTLAND","CZ":"TSJEKKIA","SK":"SLOVAKIA","HU":"UNGARN",
      "RO":"ROMANIA","BG":"BULGARIA","GR":"HELLAS","ES":"SPANIA","FR":"FRANKRIKE",
      "PT":"PORTUGAL","CN":"KINA","TH":"THAILAND","VN":"VIETNAM","IN":"INDIA"}

def caption_for(codes):
    s=set(codes)
    if len(s)==1:
        c=next(iter(s)); return "IMPORTERT FRA "+NAME.get(c,c)
    for region,label in REGION_ORDER:
        if s<=region: return "IMPORTERT FRA "+label
    if s<=EUROPA: return "IMPORTERT FRA EUROPA"
    return "IMPORTERTE NYHETER"

def cover(codes):
    cxc=(84+W)//2; sun_y=470
    yy,xx=np.mgrid[0:H,0:W]
    base=np.zeros((H,W,3))+np.array(DARK,dtype=float)
    dv=np.sqrt((xx-cxc)**2+(yy-560)**2); vig=np.clip(1-dv/950,0,1)*0.12
    base=base*(1-vig[...,None])+np.array((62,65,84))*vig[...,None]
    dg=np.sqrt((xx-cxc)**2+(yy-sun_y)**2); g=np.clip(1-dg/320,0,1)**1.7*0.55
    base=base*(1-g[...,None])+np.array(AMBER)*g[...,None]
    img=Image.fromarray(np.clip(base,0,255).astype('uint8')); d=ImageDraw.Draw(img)
    SB=84; d.rectangle([0,0,SB,H],fill=AMBER)
    sf=font(700,25); sb="frysevarer  •  snacks  •  godteri  •  drikke"
    tw=d.textlength(sb,font=sf); strip=Image.new("RGBA",(int(tw)+20,42),(0,0,0,0))
    ImageDraw.Draw(strip).text((10,8),sb,font=sf,fill=DARK); strip=strip.rotate(90,expand=True)
    img.paste(strip,(SB//2-strip.width//2,H//2-strip.height//2),strip)
    tracked(d,cxc,330,"•   K A T A L O G   •",font(700,25),AMBER,3)
    mk=logo_mark(AMBER,212); img.paste(mk,(cxc-mk.width//2,392),mk)
    tracked(d,cxc,672,"NORDIC ENGROS",font(800,76),CREAM,4)
    d.rectangle([cxc-46,772,cxc+46,776],fill=AMBER_DEEP)
    tracked(d,cxc,800,"C O N S T A N T L Y   F O R W A R D",font(600,21),MUTE_D,3)
    tracked(d,cxc,918,"NYHETER & KAMPANJE",font(800,48),AMBER,1)
    pf=font(700,28); ptw=d.textlength(WEEK,font=pf); pw=ptw+56; px=cxc-pw//2; py=992
    d.rounded_rectangle([px,py,px+pw,py+52],radius=26,outline=AMBER,width=2)
    d.text((cxc-ptw/2,py+11),WEEK,font=pf,fill=CREAM)
    cap=caption_for(codes); tracked(d,cxc,1168,cap,font(700,22),MUTE_D,4)
    CAP=9; show=codes[:CAP-1]+["+%d"%(len(codes)-(CAP-1))] if len(codes)>CAP else codes
    fw,gap=52,14; tot=len(show)*fw+(len(show)-1)*gap; fx=cxc-tot//2; fy=1212
    for c in show: img.paste(flag(c,fw,35),(fx,fy)); fx+=fw+gap
    qim=make_qr("https://www.nordicengros.no",132); pad=16; qc=132+2*pad
    fb=font(700,27); fu=font(500,23); t1,t2="Bestill i nettbutikken","www.nordicengros.no"
    tw2=max(d.textlength(t1,font=fb),d.textlength(t2,font=fu)); ig=26
    block=qc+ig+tw2; bx=int(cxc-block//2); by=1470
    d.rounded_rectangle([bx,by,bx+qc,by+qc],radius=16,fill=WHITE)
    img.paste(qim,(bx+pad,by+pad)); tx=bx+qc+ig
    d.text((tx,by+44),t1,font=fb,fill=AMBER); d.text((tx,by+84),t2,font=fu,fill=MUTE_D)
    d.rectangle([SB+40,1690,W-40,1692],fill=(58,60,74))
    d.text((SB+40,1712),"Nye varer på lager – bestill direkte i nettbutikken vår",font=font(500,23),fill=MUTE_D)
    return img

def flag(name,w=52,h=35):
    f=Image.new("RGB",(w,h),WHITE); fd=ImageDraw.Draw(f)
    def hb(c):
        for i,col in enumerate(c): fd.rectangle([0,h*i//len(c),w,h*(i+1)//len(c)],fill=col)
    def vb(c):
        for i,col in enumerate(c): fd.rectangle([w*i//len(c),0,w*(i+1)//len(c),h],fill=col)
    RED=(213,43,30);WHT=(255,255,255);GRN=(0,140,69);BLK=(0,0,0);GLD=(255,206,0)
    known=True
    if name=="PL":hb([WHT,RED])
    elif name=="DE":hb([BLK,RED,GLD])
    elif name=="NL":hb([(174,28,40),WHT,(33,70,139)])
    elif name=="RS":hb([RED,(12,68,140),WHT])
    elif name=="HR":hb([RED,WHT,(0,30,107)])
    elif name=="IT":vb([GRN,WHT,RED])
    elif name=="SI":hb([WHT,(0,51,153),RED])
    elif name=="UA":hb([(0,87,183),(255,215,0)])
    elif name=="LV":
        fd.rectangle([0,0,w,h],fill=(158,48,57)); fd.rectangle([0,int(h*0.4),w,int(h*0.6)],fill=WHT)
    elif name=="TR":
        fd.rectangle([0,0,w,h],fill=(227,10,23))
        fd.ellipse([w*0.22-11,h/2-12,w*0.22+13,h/2+12],fill=WHT)
        fd.ellipse([w*0.22-3,h/2-9,w*0.22+19,h/2+9],fill=(227,10,23))
    elif name=="CN":
        fd.rectangle([0,0,w,h],fill=(222,41,16)); Y=(255,222,0)
        _star(fd,w*0.20,h*0.32,h*0.19,Y)
        for sx,sy in [(0.40,0.13),(0.49,0.26),(0.49,0.45),(0.40,0.58)]: _star(fd,w*sx,h*sy,h*0.065,Y)
    else: known=False
    if not known:
        f=Image.new("RGB",(w,h),(58,60,74)); fd=ImageDraw.Draw(f)
        cf=font(800,15); code=name[:3] if name.startswith("+") else name[:2]
        fd.text((w/2-fd.textlength(code,font=cf)/2,h/2-9),code,font=cf,fill=CREAM); return f
    fd.rectangle([0,0,w-1,h-1],outline=(90,92,104))
    return f

# ---------------- MELLOMSIDE ----------------
CREAM_FAINT=(232,223,202); CREAM_WM=(236,228,208)
def divider(num, title, subtitle, count):
    img = Image.new("RGB",(W,H),CREAM); d=ImageDraw.Draw(img)
    # logo som svakt vannmerke nede til høyre
    mk=logo_mark(CREAM_WM,360); img.paste(mk,(W-mk.width+40,H-mk.height+30),mk); d=ImageDraw.Draw(img)
    # topp
    nwid=tracked(d,0,86,"NORDIC ",font(800,30),INK,1,left=84)
    tracked(d,0,86,"ENGROS",font(800,30),AMBER_DEEP,1,left=84+nwid)
    nt="NYHETER · "+WEEK.split(" · ")[0]
    d.text((W-84-d.textlength(nt,font=font(700,26)),90),nt,font=font(700,26),fill=MUTE_L)
    # stort faint nummer
    d.text((76,470),f"{num:02d}",font=font(800,300),fill=CREAM_FAINT)
    # kategoriord + amber-strek
    absy=792; d.text((84,absy),title,font=font(800,108),fill=INK)
    d.rectangle([88,absy+150,238,absy+158],fill=AMBER_DEEP)
    d.text((88,absy+196),subtitle,font=font(500,36),fill=MUTE_L)
    d.text((88,absy+252),f"{count} nye varer i denne kategorien",font=font(700,32),fill=AMBER_DEEP)
    # footer
    fz="nordicengros.no"; d.text((W/2-d.textlength(fz,font=font(700,26))/2,1672),fz,font=font(700,26),fill=MUTE_L)
    return img

# ---------------- STREKKODE ----------------
def make_barcode(data, tw=232, th=46):
    c=barcode.get('code128',data,writer=ImageWriter())
    bio=io.BytesIO()
    c.write(bio,options=dict(module_height=12,module_width=0.22,quiet_zone=1,write_text=False,background="white",foreground="black"))
    bio.seek(0); im=Image.open(bio).convert("RGB")
    # trim hvitt
    import numpy as np; a=np.asarray(im); cols=np.where((a<128).any(axis=2).any(axis=0))[0]
    if len(cols): im=im.crop((cols[0],0,cols[-1]+1,im.height))
    return im.resize((tw,th))

# ---------------- PRODUKTKORT ----------------
CW,CHH,RAD = 347,672,26
def image_zone(cd, x0, y0, x1, y1):
    """Ren bildesone-plassholder. Ekte Shopify-bilde (med skygge-pipeline) dropper inn her."""
    cd.rounded_rectangle([x0,y0,x1,y1], radius=16, fill=(242,242,245,255))
    gcx=(x0+x1)//2; gcy=(y0+y1)//2; t=(227,228,234,255)
    bw,bh=70,92
    cd.rounded_rectangle([gcx-bw//2,gcy-bh//2,gcx+bw//2,gcy+bh//2],radius=12,fill=t)
    cd.rounded_rectangle([gcx-20,gcy-bh//2-13,gcx+20,gcy-bh//2+9],radius=8,fill=t)

def process_product(path):
    """Fjern hvit bakgrunn (flood-fill fra kant, beholder hvitt inni) → glans → trim."""
    import numpy as np
    from scipy import ndimage
    src=Image.open(path).convert("RGB"); a=np.asarray(src)
    nw=(a>236).all(axis=2)
    lbl,_=ndimage.label(nw)
    border=set(lbl[0,:])|set(lbl[-1,:])|set(lbl[:,0])|set(lbl[:,-1]); border.discard(0)
    bg=np.isin(lbl,list(border))
    alpha=np.where(bg,0,255).astype('uint8')
    am=Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6))
    out=src.convert("RGBA"); out.putalpha(am)
    out=out.crop(out.getbbox())
    # subtil glans: lyst skinn i øvre del, maskert til produktet
    w,h=out.size; pa=out.split()[3]
    col=Image.new("L",(1,h),0)
    for y in range(h): col.putpixel((0,y),int(64*max(0,1-y/(h*0.5))))
    grad=col.resize((w,h))
    sheen=Image.new("RGBA",out.size,(255,255,255,255))
    sheen.putalpha(Image.composite(grad,Image.new("L",out.size,0),pa))
    return Image.alpha_composite(out,sheen)

def card(name, supplier, price, sku, number, image=None, nyhet=True):
    sup = Image.new("RGBA",(CW,CHH),(0,0,0,0))
    cd = ImageDraw.Draw(sup)
    cd.rounded_rectangle([0,0,CW-1,CHH-1],radius=RAD,fill=WHITE+(255,))
    # ---- produktbilde-sone ----
    if image is not None:
        prod=process_product(image)
        zy1=336; zw=CW-52; zh=zy1-26
        box_w, box_h, floor = 222, 248, 320   # mindre boks + luft rundt
        pw,ph=prod.size; scale=min(box_w/pw, box_h/ph)
        prod=prod.resize((max(1,int(pw*scale)),max(1,int(ph*scale))),Image.LANCZOS)
        pw,ph=prod.size; px=(CW-pw)//2; py=floor-ph
        # bakkeskygge (GS_WIDTH=0.94, GS_FLAT=0.18, GS_OP=120) – flat ellipse på "gulvet"
        gw=int(pw*0.94); gh=max(8,int(gw*0.18))
        gs=Image.new("RGBA",(CW,CHH),(0,0,0,0)); gd=ImageDraw.Draw(gs)
        gcx=CW//2; gcy=floor-2
        gd.ellipse([gcx-gw//2,gcy-gh//2,gcx+gw//2,gcy+gh//2],fill=(40,42,54,120))
        gs=gs.filter(ImageFilter.GaussianBlur(10))
        sup.alpha_composite(gs); sup.alpha_composite(prod,(px,py))
    else:
        image_zone(cd, 26, 26, CW-26, 332)
    # ---- navn (maks 2 linjer, sentrert, fast topp 347) ----
    nf=font(700,23); words=name.split(); lines=[]; cur=""
    for wd in words:
        t=(cur+" "+wd).strip()
        if cd.textlength(t,font=nf)<=CW-44: cur=t
        else: lines.append(cur); cur=wd
    if cur: lines.append(cur)
    lines=lines[:2]; ny=347
    for ln in lines:
        cd.text((CW/2-cd.textlength(ln,font=nf)/2,ny),ln,font=nf,fill=INK); ny+=30
    # ---- leverandør (fast 418) ----
    sf=font(500,19); cd.text((CW/2-cd.textlength(supplier,font=sf)/2,418),supplier,font=sf,fill=MUTE_L)
    # ---- pris (senter 458) oransje ----
    pf=font(800,42); cd.text((CW/2-cd.textlength(price,font=pf)/2,438),price,font=pf,fill=AMBER_DEEP)
    # ---- inkl mva · SKU (fast 512, krymper) ----
    skutxt=f"inkl. mva · SKU {sku}"; ssize=17
    while ssize>12 and ImageDraw.Draw(sup).textlength(skutxt,font=font(500,ssize))>CW-40: ssize-=1
    skf=font(500,ssize); cd.text((CW/2-cd.textlength(skutxt,font=skf)/2,512),skutxt,font=skf,fill=MUTE_L)
    # ---- strekkode (senter ~562) ----
    bc=make_barcode(number); sup.paste(bc,((CW-bc.width)//2,548))
    # ---- nummer (fast 622) ----
    numtxt=" ".join(number); nmf=font(500,18)
    if cd.textlength(numtxt,font=nmf)>CW-40: numtxt=number
    cd.text((CW/2-cd.textlength(numtxt,font=nmf)/2,600),numtxt,font=nmf,fill=(96,98,106))
    # ---- NYHET-merke (klippet til avrundet hjørne) ----
    if nyhet:
        ribbon=Image.new("RGBA",(CW,CHH),(0,0,0,0)); rd=ImageDraw.Draw(ribbon)
        rd.polygon([(CW-152,0),(CW,0),(CW,152)],fill=AMBER_DEEP+(255,))
        tag=Image.new("RGBA",(220,60),(0,0,0,0))
        tracked(ImageDraw.Draw(tag),0,12,"NYHET",font(800,18),WHITE,2,left=12)
        tag=tag.crop(tag.getbbox())                 # tett til faktisk tekst
        tag=tag.rotate(-45,expand=True,resample=Image.BICUBIC)
        cx,cy=CW-51,51                              # trekantens tyngdepunkt
        ribbon.alpha_composite(tag,(int(cx-tag.width/2),int(cy-tag.height/2)))
        mask=Image.new("L",(CW,CHH),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,CW-1,CHH-1],radius=RAD,fill=255)
        sup.paste(ribbon,(0,0),Image.composite(ribbon.split()[3],Image.new("L",(CW,CHH),0),mask))
    return sup

def paste_card_with_shadow(page, cardimg, x, y):
    blur=17; off=(0,12); op=64
    pad=blur*3
    sh=Image.new("RGBA",(CW+2*pad,CHH+2*pad),(0,0,0,0))
    shape=Image.new("RGBA",cardimg.size,DARK+(op,))
    sh.paste(shape,(pad+off[0],pad+off[1]),cardimg.split()[3])
    sh=sh.filter(ImageFilter.GaussianBlur(blur))
    page.alpha_composite(sh,(x-pad,y-pad))
    page.alpha_composite(cardimg,(x,y))

# ---------------- PRODUKTSIDE ----------------
def product_page(category, products, page_no, total_pages):
    img=Image.new("RGBA",(W,H),CREAM+(255,)); d=ImageDraw.Draw(img)
    # header
    tracked(d,0,64,"NORDIC ",font(800,34),INK,1,left=64)
    nwid=d.textlength("NORDIC ",font=font(800,34))
    tracked(d,0,64,"ENGROS",font(800,34),AMBER_DEEP,1,left=64+nwid+4)
    d.text((64,104),category.title(),font=font(800,52),fill=INK)
    wf=font(700,30); d.text((W-64-d.textlength(WEEK,font=wf),120),WEEK,font=wf,fill=MUTE_L)
    d.line([(64,196),(W-64,196)],fill=(222,216,200),width=2)
    # kort-rutenett – vertikalt sentrert, hver rad horisontalt sentrert
    gut_x,gut_y=35,33
    items=products[:6]
    rows=[items[i:i+3] for i in range(0,len(items),3)]
    grid_h=len(rows)*CHH+(len(rows)-1)*gut_y
    content_top,content_bot=210,1672
    y=content_top+max(0,(content_bot-content_top-grid_h))//2
    for row in rows:
        rw=len(row)*CW+(len(row)-1)*gut_x
        x=(W-rw)//2
        for p in row:
            paste_card_with_shadow(img,card(*p[:7]),x,y); x+=CW+gut_x
        y+=CHH+gut_y
    # footer
    fz1="Bestill i nettbutikken"; fz2=" · nordicengros.no"
    f1=font(800,28); f2=font(700,28)
    tot=d.textlength(fz1,font=f1)+d.textlength(fz2,font=f2); fx=W/2-tot/2
    d.text((fx,1690),fz1,font=f1,fill=AMBER_DEEP); d.text((fx+d.textlength(fz1,font=f1),1690),fz2,font=f2,fill=AMBER_DEEP)
    sidetxt=f"Side {page_no} / {total_pages}"
    d.text((W-64-d.textlength(sidetxt,font=font(500,26)),1692),sidetxt,font=font(500,26),fill=MUTE_L)
    return img.convert("RGB")

# ---------------- KONTAKTSIDE ----------------
def contact():
    img=Image.new("RGB",(W,H),DARK); d=ImageDraw.Draw(img)
    cxc=W//2
    circ=Image.new("L",(W,H),0); ImageDraw.Draw(circ).ellipse([cxc-460,180,cxc+460,1100],fill=34)
    circ=circ.filter(ImageFilter.GaussianBlur(2)); img.paste(Image.new("RGB",(W,H),DARK_LITE),(0,0),circ); d=ImageDraw.Draw(img)
    mk=logo_mark(AMBER,170); img.paste(mk,(cxc-mk.width//2,440),mk)
    nf=font(800,64); d.text((cxc-d.textlength("Nordic Engros AS",font=nf)/2,650),"Nordic Engros AS",font=nf,fill=AMBER)
    for i,t in enumerate(["Org. 922 796 076","Oslo, Norge"]):
        tf=font(500,32); d.text((cxc-d.textlength(t,font=tf)/2,748+i*48),t,font=tf,fill=CREAM)
    tracked(d,cxc,900,"K O N T A K T   O S S",font(800,30),AMBER,2)
    for i,t in enumerate(["+47 00 00 00 00","post@nordicengros.no"]):
        tf=font(500,32); d.text((cxc-d.textlength(t,font=tf)/2,962+i*48),t,font=tf,fill=CREAM)
    tracked(d,cxc,1100,"www.nordicengros.no",font(700,28),AMBER,2)
    return img

# ---------------- BYGG PDF ----------------
DATA=[
 ("FRYSEVARER","Kjøtt og frysevarer fra Europa",[
   ("Kyllingvinger","NordFood","kr 129,00","FRY-1001","703900100015",None,True,"PL"),
   ("Lammekoteletter","NordFood","kr 189,50","FRY-1002","703900100022",None,True,"DE"),
   ("Pommes frites","Aviko","kr 79,90","FRY-1004","703900100046",None,False,"NL")]),
 ("SNACKS","Chips og snacks",[
   ("Cheetos Ketchup Family Bag","Cheetos","kr 34,90","SNK-3008","590467131420","extracted/p4_0_1024x1024.png",True,"PL"),
   ("Smoki","Stark","kr 18,90","SNK-3010","703900300019",None,True,"RS"),
   ("Napolitanke","Kras","kr 22,90","SNK-3011","703900300026",None,False,"HR")]),
 ("GODTERI","Sjokolade og søtsaker",[
   ("Raffaello 150g","Ferrero","kr 49,90","GOD-4001","800500006016","extracted/p6_0_1024x1024.png",True,"IT"),
   ("Bajadera","Kras","kr 64,90","GOD-4002","800500006023",None,True,"HR")]),
 ("DRIKKE","Brus og drikke",[
   ("Cockta","Droga Kolinska","kr 21,90","DRK-2201","703900200012",None,True,"SI"),
   ("Sutas Ayran","Sutas","kr 14,90","DRK-2202","703900200029",None,False,"TR")]),
]

from collections import Counter
_cnt=Counter()
for _,_,prods in DATA:
    for p in prods: _cnt[p[7]]+=1
CODES=[c for c,_ in _cnt.most_common()]   # alle land i utgaven, flest varer først

pages=[cover(CODES)]
total_pp=sum(math.ceil(len(p)/6) for _,_,p in DATA)
pno=1
for i,(cat,sub,prods) in enumerate(DATA,1):
    pages.append(divider(i,cat,sub,len(prods)))
    for k in range(0,len(prods),6):
        pages.append(product_page(cat,prods[k:k+6],pno,total_pp)); pno+=1
pages.append(contact())

pages[0].save("Nordic-Engros-Nyheter-NY.pdf",save_all=True,append_images=pages[1:],resolution=150.0)
for k,p in enumerate(pages): p.save(f"pg_{k:02d}.png")
# DEMO: full side med 6 ekte varer for å vise 3x2-rutenettet
demo6=[
 ("Cheetos Ketchup Family Bag","Cheetos","kr 34,90","SNK-3008","590467131420","extracted/p4_0_1024x1024.png",True),
 ("Smoki","Stark","kr 18,90","SNK-3010","703900300019",None,True),
 ("Napolitanke","Kras","kr 22,90","SNK-3011","703900300026",None,False),
 ("Raffaello 150g","Ferrero","kr 49,90","GOD-4001","800500006016","extracted/p6_0_1024x1024.png",True),
 ("Bajadera","Kras","kr 64,90","GOD-4002","800500006023",None,True),
 ("Cockta","Droga Kolinska","kr 21,90","DRK-2201","703900200012",None,True)]
product_page("NYHETER", demo6, 1, 1).save("full_page_demo.png")
print("Ferdig:",len(pages),"sider")
