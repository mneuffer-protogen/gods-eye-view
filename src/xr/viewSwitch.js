/**
 * Switching the table between the globe and the tabletop map. The globe
 * sinks into its base as the map rises out of the table, over a fraction of
 * a second, so the change reads as one object becoming the other rather
 * than a cut.
 */

export const VIEW_SWITCH = Object.freeze({ seconds: 0.7 });

/** Smoothstep ease of a 0..1 progress. */
export function ease(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Step `amount` (0 globe .. 1 map) toward `target` over `dt` seconds. */
export function stepAmount(amount, target, dt, seconds = VIEW_SWITCH.seconds) {
  const goal = target === 'tabletop' ? 1 : 0;
  const step = dt / seconds;
  return goal > amount
    ? Math.min(goal, amount + step)
    : Math.max(goal, amount - step);
}

/**
 * @param {object} options
 * @param {ReturnType<import('./globeTable.js').createGlobeTable>} options.globeTable
 * @param {ReturnType<import('./tabletopView.js').createTabletopView>} options.tabletop
 */
export function createViewSwitch({ globeTable, tabletop }) {
  const column = globeTable.table.getObjectByName('Light column');
  let target = 'globe';
  let amount = 0;

  function apply() {
    const e = ease(amount);
    const globeShare = Math.max(1e-4, 1 - e);
    globeTable.pivot.scale.setScalar(globeShare);
    globeTable.pivot.visible = e < 0.999;
    if (column) {
      column.visible = e < 0.999;
      column.material.uniforms.strength.value = 0.16 * (1 - e);
    }
    // The globe's small glass base gives way to the map's larger one.
    globeTable.base.visible = e < 0.5;
    tabletop.group.visible = e > 0.001;
    tabletop.group.scale.setScalar(Math.max(1e-3, e));
  }
  apply();

  return {
    /** The view being shown, or switched to. */
    get target() {
      return target;
    },
    /** Which view takes input: the one being switched to. */
    get input() {
      return target;
    },
    /** True while the map shows at all, so it needs per-frame updates. */
    get mapShowing() {
      return amount > 0;
    },
    get switching() {
      return amount !== (target === 'tabletop' ? 1 : 0);
    },
    show(view) {
      target = view === 'tabletop' ? 'tabletop' : 'globe';
    },
    update(dt) {
      if (!this.switching) return;
      amount = stepAmount(amount, target, dt);
      apply();
    },
  };
}
