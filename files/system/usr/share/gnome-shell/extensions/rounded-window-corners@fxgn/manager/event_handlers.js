/**
 * @file Contains the implementation of handlers for various events that need
 * to be processed by the extension. Those handlers are bound to event signals
 * in effect_manager.ts.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { ClipShadowEffect } from '../effect/clip_shadow_effect.js';
import { RoundedCornersEffect } from '../effect/rounded_corners_effect.js';
import { CLIP_SHADOW_EFFECT, ROUNDED_CORNERS_EFFECT, } from '../utils/constants.js';
import { logDebug } from '../utils/log.js';
import { getPref } from '../utils/settings.js';
import { computeBounds, computeShadowActorOffset, computeWindowContentsOffset, getRoundedCornersCfg, getRoundedCornersEffect, shouldEnableEffect, unwrapActor, updateShadowActorStyle, windowScaleFactor, } from './utils.js';
export function onAddEffect(actor) {
    logDebug(`opened: ${actor?.metaWindow.title}: ${actor}`);
    const win = actor.metaWindow;
    if (!shouldEnableEffect(win)) {
        logDebug(`Skipping ${win.title}`);
        return;
    }
    unwrapActor(actor)?.add_effect_with_name(ROUNDED_CORNERS_EFFECT, new RoundedCornersEffect());
    const shadow = createShadow(actor);
    // Bind properties of the window to the shadow actor.
    for (const prop of [
        'pivot-point',
        'translation-x',
        'translation-y',
        'scale-x',
        'scale-y',
        'visible',
    ]) {
        actor.bind_property(prop, shadow, prop, GObject.BindingFlags.SYNC_CREATE);
    }
    // Store shadow, app type, visible binding, so that we can access them later
    actor.rwcCustomData = {
        shadow,
        unminimizedTimeoutId: 0,
    };
    // Run those handlers once to make sure the effect is applied correctly.
    refreshRoundedCorners(actor);
    refreshShadow(actor);
}
export function onRemoveEffect(actor) {
    const name = ROUNDED_CORNERS_EFFECT;
    unwrapActor(actor)?.remove_effect_by_name(name);
    // Remove shadow actor
    const shadow = actor.rwcCustomData?.shadow;
    if (shadow) {
        global.windowGroup.remove_child(shadow);
        shadow.clear_effects();
        shadow.destroy();
    }
    // Remove all timeout handler
    const timeoutId = actor.rwcCustomData?.unminimizedTimeoutId;
    if (timeoutId) {
        GLib.source_remove(timeoutId);
    }
    delete actor.rwcCustomData;
}
export function onMinimize(actor) {
    // Compatibility with "Compiz alike magic lamp effect".
    // When minimizing a window, disable the shadow to make the magic lamp effect
    // work.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const shadow = actor.rwcCustomData?.shadow;
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    if (magicLampEffect && shadow && roundedCornersEffect) {
        logDebug('Minimizing with magic lamp effect');
        shadow.visible = false;
        roundedCornersEffect.enabled = false;
    }
}
export function onUnminimize(actor) {
    // Compatibility with "Compiz alike magic lamp effect".
    // When unminimizing a window, wait until the effect is completed before
    // showing the shadow.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const shadow = actor.rwcCustomData?.shadow;
    const roundedCornersEffect = getRoundedCornersEffect(actor);
    if (magicLampEffect && shadow && roundedCornersEffect) {
        shadow.visible = false;
        const timer = magicLampEffect.timerId;
        const id = timer.connect('new-frame', source => {
            // Wait until the effect is 98% completed
            if (source.get_progress() > 0.98) {
                logDebug('Unminimizing with magic lamp effect');
                shadow.visible = true;
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
            }
        });
        return;
    }
}
export function onRestacked() {
    for (const actor of global.get_window_actors()) {
        const shadow = actor.rwcCustomData?.shadow;
        if (!(actor.visible && shadow)) {
            continue;
        }
        global.windowGroup.set_child_below_sibling(shadow, actor);
    }
}
export const onSizeChanged = refreshRoundedCorners;
export const onFocusChanged = refreshShadow;
export function onSettingsChanged(key) {
    switch (key) {
        case 'skip-libadwaita-app':
        case 'skip-libhandy-app':
        case 'blacklist':
            refreshEffectState();
            break;
        case 'focused-shadow':
        case 'unfocused-shadow':
            refreshAllShadows();
            break;
        case 'global-rounded-corner-settings':
        case 'custom-rounded-corner-settings':
        case 'border-width':
        case 'tweak-kitty-terminal':
            refreshAllRoundedCorners();
            break;
        default:
    }
}
/**
 * Create the shadow actor for a window.
 *
 * @param actor - The window actor to create the shadow actor for.
 */
function createShadow(actor) {
    const shadow = new St.Bin({
        name: 'Shadow Actor',
        child: new St.Bin({
            xExpand: true,
            yExpand: true,
        }),
    });
    shadow.firstChild.add_style_class_name('shadow');
    refreshShadow(actor);
    // We have to clip the shadow because of this issue:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4474
    shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());
    // Draw the shadow actor below the window actor.
    global.windowGroup.insert_child_below(shadow, actor);
    // Bind position and size between window and shadow
    for (let i = 0; i < 4; i++) {
        const constraint = new Clutter.BindConstraint({
            source: actor,
            coordinate: i,
            offset: 0,
        });
        shadow.add_constraint(constraint);
    }
    return shadow;
}
/** Traverse all windows, and check if they should have rounded corners. */
function refreshEffectState() {
    for (const actor of global.get_window_actors()) {
        const shouldHaveEffect = shouldEnableEffect(actor.metaWindow);
        const hasEffect = getRoundedCornersEffect(actor) != null;
        if (shouldHaveEffect && !hasEffect) {
            onAddEffect(actor);
            refreshRoundedCorners(actor);
            return;
        }
        if (!shouldHaveEffect && hasEffect) {
            onRemoveEffect(actor);
            return;
        }
    }
}
/**
 * Refresh the shadow actor for a window.
 *
 * @param actor - The window actor to refresh the shadow for.
 */
function refreshShadow(actor) {
    const win = actor.metaWindow;
    const shadow = actor.rwcCustomData?.shadow;
    if (!shadow) {
        return;
    }
    const shadowSettings = win.appears_focused
        ? getPref('focused-shadow')
        : getPref('unfocused-shadow');
    const { borderRadius, padding } = getRoundedCornersCfg(win);
    updateShadowActorStyle(win, shadow, borderRadius, shadowSettings, padding);
}
/** Refresh the style of all shadow actors */
function refreshAllShadows() {
    for (const actor of global.get_window_actors()) {
        refreshShadow(actor);
    }
}
/**
 * Refresh rounded corners settings for a window.
 *
 * @param actor - The window actor to refresh the rounded corners settings for.
 */
function refreshRoundedCorners(actor) {
    const win = actor.metaWindow;
    const windowInfo = actor.rwcCustomData;
    const effect = getRoundedCornersEffect(actor);
    const shouldHaveEffect = shouldEnableEffect(win);
    if (!(effect && windowInfo)) {
        if (shouldHaveEffect) {
            logDebug(`Adding previously missing effect to ${win.title}`);
            onAddEffect(actor);
        }
        return;
    }
    // Skip rounded corners when window is fullscreen & maximize
    const cfg = getRoundedCornersCfg(win);
    if (effect.enabled !== shouldHaveEffect) {
        effect.enabled = shouldHaveEffect;
        refreshShadow(actor);
    }
    const windowContentOffset = computeWindowContentsOffset(win);
    // When window size is changed, update uniforms for corner rounding shader.
    effect.updateUniforms(windowScaleFactor(win), cfg, computeBounds(actor, windowContentOffset));
    // Update BindConstraint for the shadow
    const shadow = windowInfo.shadow;
    const offsets = computeShadowActorOffset(actor, windowContentOffset);
    const constraints = shadow.get_constraints();
    constraints.forEach((constraint, i) => {
        if (constraint instanceof Clutter.BindConstraint) {
            constraint.offset = offsets[i];
        }
    });
}
/** Refresh rounded corners settings for all windows. */
function refreshAllRoundedCorners() {
    for (const actor of global.get_window_actors()) {
        refreshRoundedCorners(actor);
    }
    refreshAllShadows();
}
