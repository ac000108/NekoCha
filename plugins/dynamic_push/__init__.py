# -*- coding: utf-8 -*-
"""动态推送插件 - 接收系统分发的动态消息，生成卡片推送到QQ群"""

import io
import os
import re
import urllib.request

from core.plugin_manager import BasePlugin


def _download_image(url: str):
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={'Referer': 'https://www.bilibili.com/'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
        from PIL import Image
        return Image.open(io.BytesIO(data)).convert('RGB')
    except Exception:
        return None


def draw_dynamic_card(msg: dict) -> bytes:
    """根据系统动态消息生成卡片图片"""
    from PIL import Image, ImageDraw, ImageFont

    font_path = os.path.join(os.path.dirname(__file__), 'fonts', 'Yozai-Regular.ttf')
    if not os.path.exists(font_path):
        font_path = None

    fallback_font_paths = []
    for fp in [
        r'C:\Windows\Fonts\segoeuisl.ttf',
        r'C:\Windows\Fonts\seguiemj.ttf',
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\simsun.ttc',
    ]:
        if os.path.exists(fp):
            fallback_font_paths.append(fp)

    def font(size):
        if font_path:
            return ImageFont.truetype(font_path, size)
        return ImageFont.load_default()

    def fallback_font(size):
        for fp in fallback_font_paths:
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                continue
        return font(size)

    def char_in_font(f, ch):
        try:
            return ord(ch) in f.font.get_charmap()
        except Exception:
            return False

    def wrap_text(draw_obj, text, fnt, max_width):
        if not text:
            return []
        lines = []
        for para in text.split('\n'):
            line = ''
            for ch in para:
                test = line + ch
                bbox = draw_obj.textbbox((0, 0), test, font=fnt)
                if bbox[2] - bbox[0] > max_width:
                    lines.append(line)
                    line = ch
                else:
                    line = test
            if line:
                lines.append(line)
        return lines

    def draw_text_with_emoji(draw_obj, img_obj, text, fnt, emoji_map, x, y, max_width, line_height):
        segments = re.split(r'(\[[^\]]+\]|@\S+)', text)
        emoji_size = fnt.size
        fb_font = fallback_font(fnt.size)
        cur_x = x
        cur_y = y
        emoji_cache = {}
        for seg in segments:
            if not seg:
                continue
            if seg.startswith('@'):
                for ch in seg:
                    use_font = fnt if char_in_font(fnt, ch) else fb_font
                    bbox = draw_obj.textbbox((0, 0), ch, font=use_font)
                    w = bbox[2] - bbox[0]
                    if cur_x + w > x + max_width and cur_x > x:
                        cur_x = x
                        cur_y += line_height
                    draw_obj.text((cur_x, cur_y), ch, fill='#00AEEC', font=use_font)
                    cur_x += w
            elif seg.startswith('[') and seg.endswith(']') and seg in emoji_map:
                if seg not in emoji_cache:
                    em = _download_image(emoji_map[seg])
                    if em:
                        em = em.resize((emoji_size, emoji_size), Image.LANCZOS)
                    emoji_cache[seg] = em
                em = emoji_cache[seg]
                if em:
                    if cur_x + emoji_size > x + max_width:
                        cur_x = x
                        cur_y += line_height
                    img_obj.paste(em, (cur_x, cur_y + (line_height - emoji_size) // 2), em if em.mode == 'RGBA' else None)
                    cur_x += emoji_size
                else:
                    use_font = fnt if char_in_font(fnt, seg) else fb_font
                    bbox = draw_obj.textbbox((0, 0), seg, font=use_font)
                    w = bbox[2] - bbox[0]
                    if cur_x + w > x + max_width:
                        cur_x = x
                        cur_y += line_height
                    draw_obj.text((cur_x, cur_y), seg, fill='#18191C', font=use_font)
                    cur_x += w
            else:
                for ch in seg:
                    if ch == '\n':
                        cur_x = x
                        cur_y += line_height
                        continue
                    use_font = fnt if char_in_font(fnt, ch) else fb_font
                    bbox = draw_obj.textbbox((0, 0), ch, font=use_font)
                    w = bbox[2] - bbox[0]
                    if cur_x + w > x + max_width and cur_x > x:
                        cur_x = x
                        cur_y += line_height
                    draw_obj.text((cur_x, cur_y), ch, fill='#18191C', font=use_font)
                    cur_x += w
        return cur_y + line_height

    # ---- 提取消息内容 ----
    name = msg.get('作者', 'Unknown')
    face = msg.get('作者头像', '')
    pub_time_display = msg.get('发布时间', '')
    dyn_type = msg.get('动态类型', '')
    text_content = msg.get('配文', '')

    # 表情映射
    merged_emoji_map = dict(msg.get('动态表情', {}) or {})

    # 过滤无法识别的表情标签
    if merged_emoji_map:
        text_content = re.sub(r'\[[^\]]+\]', lambda m: m.group() if m.group() in merged_emoji_map else '', text_content)
    text_content = text_content.strip()

    # 动作描述
    action_text = '发布了动态'
    if dyn_type == 'DYNAMIC_TYPE_AV':
        action_text = '投稿了视频'
    elif dyn_type == 'DYNAMIC_TYPE_ARTICLE':
        action_text = '投稿了专栏'
    elif dyn_type == 'DYNAMIC_TYPE_FORWARD':
        action_text = '转发了动态'

    # 视频/图文信息
    is_video = dyn_type == 'DYNAMIC_TYPE_AV'
    video_title = msg.get('视频标题', '')
    video_desc = msg.get('视频简介', '')
    cover_url = msg.get('视频封面', '') if is_video else ''
    duration_text = msg.get('视频时长', '')
    pics = msg.get('图片列表', []) if not is_video else []
    if not cover_url and pics:
        cover_url = pics[0]

    # ---- 布局参数 ----
    SCALE = 1.5
    W = int(720 * SCALE)
    MARGIN = int(24 * SCALE)
    content_width = W - MARGIN * 2

    def s(v): return int(v * SCALE)

    name_font = font(s(24))
    meta_font = font(s(18))
    body_font = font(s(24))
    mini_font = font(s(16))

    temp_draw = ImageDraw.Draw(Image.new('RGB', (10, 10), 'white'))

    avatar_size = s(48)
    avatar_img = _download_image(face) if face else None
    if avatar_img:
        avatar_img = avatar_img.resize((avatar_size, avatar_size), Image.LANCZOS)

    header_h = avatar_size + s(16)

    text_lines = wrap_text(temp_draw, text_content, body_font, content_width)
    text_h = len(text_lines) * s(36)

    card_h = 0
    cover_img = _download_image(cover_url) if cover_url else None

    if is_video and cover_img:
        card_cover_w = s(220)
        ratio = card_cover_w / cover_img.width
        card_cover_h = int(cover_img.height * ratio)
        cover_img = cover_img.resize((card_cover_w, card_cover_h), Image.LANCZOS)
        card_h = card_cover_h
    elif cover_img:
        max_w = int(content_width * 0.6)
        if cover_img.width > max_w:
            ratio = max_w / cover_img.width
            cw = max_w
            card_cover_h = int(cover_img.height * ratio)
        else:
            cw = cover_img.width
            card_cover_h = cover_img.height
        if card_cover_h > s(500):
            ratio = s(500) / card_cover_h
            cw = int(cw * ratio)
            card_cover_h = s(500)
        cover_img = cover_img.resize((cw, card_cover_h), Image.LANCZOS)
        card_h = card_cover_h

    total_h = MARGIN + header_h + (text_h + 16 if text_lines else 0) + (card_h + 16 if card_h else 0) + MARGIN

    img = Image.new('RGB', (W, total_h), '#FFFFFF')
    draw = ImageDraw.Draw(img)
    y = MARGIN

    if avatar_img:
        circle_mask = Image.new('L', (avatar_size, avatar_size), 0)
        ImageDraw.Draw(circle_mask).ellipse([0, 0, avatar_size, avatar_size], fill=255)
        avatar_round = Image.new('RGBA', (avatar_size, avatar_size), (0, 0, 0, 0))
        avatar_round.paste(avatar_img, (0, 0), circle_mask)
        img.paste(avatar_round, (MARGIN, y), avatar_round)

    name_x = MARGIN + avatar_size + s(12)
    draw.text((name_x, y + s(4)), name, fill='#18191C', font=name_font)
    meta = f'{pub_time_display} · {action_text}'
    draw.text((name_x, y + s(34)), meta, fill='#9499A0', font=meta_font)
    y += header_h

    if text_content:
        y = draw_text_with_emoji(draw, img, text_content, body_font, merged_emoji_map, MARGIN, y, content_width, s(36))
        y += s(10)

    if is_video and cover_img:
        card_bg_x = MARGIN
        card_bg_w = content_width
        draw.rounded_rectangle([card_bg_x, y, card_bg_x + card_bg_w, y + card_h], radius=s(8), fill='#F1F2F3')
        cover_mask = Image.new('L', (card_cover_w, card_cover_h), 0)
        ImageDraw.Draw(cover_mask).rounded_rectangle([0, 0, card_cover_w, card_cover_h], radius=s(6), fill=255)
        img.paste(cover_img, (card_bg_x, y), cover_mask)
        if duration_text:
            tb = mini_font.getbbox(duration_text)
            tw = tb[2] - tb[0]
            th = tb[3] - tb[1]
            dur_x = card_bg_x + card_cover_w - tw - s(8)
            dur_y = y + card_cover_h - th - s(6)
            draw.text((dur_x + 1, dur_y + 1), duration_text, fill='#00000080', font=mini_font)
            draw.text((dur_x, dur_y), duration_text, fill='#FFFFFF', font=mini_font)
        text_x = card_bg_x + card_cover_w + s(14)
        text_area_w = card_bg_w - card_cover_w - s(14) - s(10)
        title_font_card = font(s(24))
        desc_font_card = font(s(16))
        title_lines = wrap_text(temp_draw, video_title, title_font_card, text_area_w)[:2]
        desc_lines_raw = wrap_text(temp_draw, video_desc, desc_font_card, text_area_w)
        desc_lines = desc_lines_raw[:2]
        if len(desc_lines_raw) > 2:
            last = desc_lines[-1]
            if last:
                desc_lines[-1] = last[:-1] + '…'
        cy = y + s(4)
        for line in title_lines:
            draw.text((text_x, cy), line, fill='#00B5E2', font=title_font_card)
            cy += s(32)
        if desc_lines:
            cy += s(6)
        for line in desc_lines:
            draw.text((text_x, cy), line, fill='#61666D', font=desc_font_card)
            cy += s(22)
        y += card_h + s(16)
    elif cover_img:
        cx = MARGIN + (content_width - cw) // 2
        draw_mask = Image.new('L', (cw, card_cover_h), 0)
        ImageDraw.Draw(draw_mask).rounded_rectangle([0, 0, cw, card_cover_h], radius=s(8), fill=255)
        img.paste(cover_img, (cx, y), draw_mask)
        y += card_h + s(16)

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=92)
    return buf.getvalue()


class DynamicPushPlugin(BasePlugin):
    """动态推送插件"""

    NAPCAT_URL = 'http://nekocha.ac000108.cn'
    NAPCAT_TOKEN = 'loerkn7b-fBPPm-2'

    def _napcat_post(self, group_id, endpoint: str, payload: dict) -> dict:
        import requests
        base_url = self.NAPCAT_URL.rstrip('/')
        url = f"{base_url}{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if self.NAPCAT_TOKEN:
            headers['Authorization'] = f'Bearer {self.NAPCAT_TOKEN}'
        full_payload = {'group_id': group_id, **payload}
        try:
            resp = requests.post(url, json=full_payload, headers=headers, timeout=30)
            try:
                data = resp.json()
            except Exception:
                data = {}
            if data.get('retcode') == 0:
                return {'success': True}
            return {'success': False, 'retcode': data.get('retcode'), 'message': data.get('message', '')}
        except Exception as e:
            return {'success': False, 'message': str(e)}

    def _send_group_text(self, group_id, message: str) -> dict:
        segments = [{'type': 'text', 'data': {'text': message}}]
        return self._napcat_post(group_id, '/send_group_msg', {'message': segments})

    def _send_group_image(self, group_id, image_bytes: bytes) -> dict:
        import base64
        b64 = base64.b64encode(image_bytes).decode('utf-8')
        segments = [{'type': 'image', 'data': {'file': f'base64://{b64}'}}]
        return self._napcat_post(group_id, '/send_group_msg', {'message': segments})

    def process_message(self, message: dict):
        if message.get('消息类型') != '动态':
            return

        group_id = str(self._config.get('QQ群号', '')).strip()
        if not group_id:
            return
        try:
            group_id = int(group_id)
        except (ValueError, TypeError):
            return

        name = message.get('作者', '')
        dyn_type = message.get('动态类型', '')

        # 文字摘要
        if self._config.get('推送文字摘要', False):
            text = message.get('配文', '')
            if dyn_type == 'DYNAMIC_TYPE_AV':
                text = f'{name} 投稿了视频: {message.get("视频标题", "")}'
            elif text:
                text = f'{name} 发布了动态: {text}'
            if text:
                self._send_group_text(group_id, text)

        # 图片卡片
        if self._config.get('推送图片卡片', True):
            try:
                card_bytes = draw_dynamic_card(message)
                if card_bytes:
                    self._send_group_image(group_id, card_bytes)
            except Exception as e:
                print(f"[{self.name}] 生成卡片失败: {e}")
