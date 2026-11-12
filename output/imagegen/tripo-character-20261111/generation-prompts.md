# 角色 T-Pose 三视图

生成方式：内置 imagegen。日期：2026-11-11。

源图：用户提供的 `codex-clipboard-72c10ae7-9119-4816-9ef6-dff844fc83fd.png`。

交付文件均为 1254 × 1254 的透明 RGBA PNG：

- `front-tpose.png`：正面 T-Pose，可作为主参考图。
- `left-side-tpose.png`：左侧正交视图，角色朝画面左侧。手臂保持 T-Pose，所以在该视角沿视线方向重叠。
- `back-tpose.png`：背面 T-Pose。

原图没有展示的背部、侧面结构由模型依据服装和人物特征补全。这些图片未经过 Tripo 建模验证。

以下为三张交付图使用的完整提示词。正面以原图为参考；侧面以正面和原图为参考；背面以正面、侧面和原图为参考。

## 正面

```text
Use case: identity-preserve.
Asset type: a single front-view character T-pose reference for image-to-3D modeling in Tripo.
Input image 1 is the character identity, costume, proportions, and illustration-style reference. Repose this exact same adult male character into a technically clean standard full-body T-pose. Deliver ONLY ONE character, directly facing the camera, strict front orthographic view, no perspective or three-quarter angle. Upright head with neutral expression, eyes straight ahead; squared level shoulders and pelvis; both arms straight and horizontal at shoulder height at exactly 90 degrees to the torso; elbows and wrists straight; hands flat, palms facing the ground, five natural fingers per hand gently separated and aligned; legs straight and parallel, feet pointing straight forward and separated by a small natural gap. Full silhouette including all hair, fingertips and shoe soles must be visible, generously uncropped, centered on a square canvas with balanced blank margin.
Preserve identity closely: light warm skin, swept-back dark brown wavy short hair, strong eyebrows, angular handsome face, short connected moustache and goatee with neatly trimmed jaw beard, athletic slim tall adult build, long legs. Preserve the charcoal gray tailored three-piece suit, notched lapels, matching dark buttoned waistcoat, white shirt, burgundy necktie with small horizontal gold tie clip, small white pocket square on his anatomical left breast, burgundy jacket lining visible only where natural, charcoal trousers, polished black lace-up Oxford shoes. Match the reference's high-quality semi-realistic anime/comic illustration and material colors; make clothing folds suitable for arms extended. Jacket hangs naturally with moderate opening, no floating tails. Consistent soft neutral illumination, clear readable clothing construction, restrained shadows and specular highlights suitable for reconstruction. No harsh directional rim lighting, dramatic cast shadows, pose exaggeration, pockets containing hands, props, text, grids, borders, labels, watermark, extra people, extra limbs, jewelry or redesign.
Background: genuinely transparent RGBA, clean antialiased silhouette without black matte or colored fringe. This output is the canonical front view to match for later side and rear views.
```

## 左侧

```text
Use case: identity-preserve.
Asset type: SINGLE strictly orthographic LEFT SIDE VIEW for the same character's T-pose image-to-3D reference set.
Input 1 is the canonical front T-pose to match exactly for identity, costume geometry, proportions, size and posing. Input 2 is supporting original character identity and costume detail. Render the SAME standing male character from exactly 90 degrees at his anatomical left side, facing the LEFT edge of the image. Rotate camera only; do not change his 3D pose. The whole character must be in pure profile: one eye, nose and chin in full left-facing profile; shoulders and hips stack exactly; feet and legs overlap in pure side projection. No three-quarter rotation.
CRITICAL POSE GEOMETRY: He is STILL in a standard T-pose: both straight arms extend laterally to his left and right at shoulder height. In this strictly SIDE view the nearest arm points STRAIGHT AT the camera and the other points AWAY. Therefore the arms are seen end-on and OVERLAP at the shoulder, with a normally sized foreshortened hand at shoulder height. The arms must NOT stretch horizontally toward the left or right of this side-view image; that would be a different pose. Palms face down; fingers straight, close but naturally separate. Preserve the body visible below the shoulder. No hanging arm, no arm reaching forward, no changed elbow pose. No perspective enlargement of the near hand.
Match the front image exactly: swept-back short dark brown wavy hair, warm fair skin, angular adult male face, neat moustache and goatee/beard, tall slim-athletic long-legged build; charcoal fitted notched-lapel jacket with natural hip-length hem, matching buttoned waistcoat, white collared shirt, burgundy tie with gold tie bar, white pocket square, matching straight trousers and polished black Oxford lace-up shoes. Rear suit construction should be simple plausible tailoring, consistent with reference. No added accessories or redesigned costume.
Maintain same semi-realistic anime/comic illustration, same restrained neutral soft lighting and colors. Full body hair to soles uncropped, centered in a square image; figure height and top/bottom margins match canonical front (roughly 96% image height), generous blank lateral space. Genuinely transparent RGBA background with clean edges. No labels, text, guide lines, frames, other characters, props, ground shadow or watermark.
```

## 背面

```text
Use case: identity-preserve.
Asset type: SINGLE rear orthographic T-pose reference for image-to-3D reconstruction.
Input 1 is canonical FRONT T-pose; input 2 is canonical LEFT SIDE of that pose; input 3 supplies original character identity. Render that EXACT same male character and costume directly from BEHIND, 180 degrees from input 1. Rotate camera only, keeping the exact same T-pose and proportions, garment length, silhouette and anatomy. No three-quarter view, no face visible, no turn of the head or torso.
Both arms are fully straight and horizontal at shoulder level, elbows and wrists straight, palms DOWN, all fingers straight and naturally close with gentle separation. Seen from the back the hands show the thumb on the appropriate forward side, anatomically correct. Upright centered head; level shoulders and pelvis; legs straight, parallel and spaced the same as front; shoes directed straight away from camera, showing heels. Entire character uncropped, all fingertips, hair and shoe soles inside frame. Square transparent canvas with same scale and positioning as input 1: roughly 96% height, small but safe outer margins.
Preserve swept-back short dark brown wavy hair with natural tapered nape, same ears and neck, tall slim-athletic adult body with long legs, tailored charcoal-gray suit jacket, natural shoulder construction, no shoulder pads exaggeration, charcoal straight suit trousers, white shirt cuffs with small dark cuff details, black polished Oxford shoe heels. Rear jacket has understated center back seam and normal paired side vents, hip-length hem matching the front and side views; no exposed waistcoat or shirt on back and no added belt or rear ornament. Do not draw tie, lapels, breast pocket or waistcoat on his back.
Match the same semi-realistic anime/comic illustration rendering, precise clean silhouette and restrained soft neutral illumination. Preserve charcoal fabric tones; no strong directional rim light, hard cast shadow, heavy black blocks or changed material. Genuinely transparent RGBA background, no floor, scene, text, labels, guide lines, border, watermark, props, additional characters or limbs.
```
