;(function () {
  if (window.ControlFeatureRegistry) {
    return;
  }

  const groups = new Map();
  const featureIndex = new Map();

  function ensureGroup(groupId, meta = {}) {
    if (!groupId) {
      throw new Error('[ControlFeatureRegistry] groupId 不能为空');
    }

    if (!groups.has(groupId)) {
      groups.set(groupId, {
        id: groupId,
        meta: {
          title: meta.title || '',
          description: meta.description || '',
          icon: meta.icon || '',
        },
        features: [],
        order: meta.order ?? Number.MAX_SAFE_INTEGER,
      });
    } else if (meta && Object.keys(meta).length > 0) {
      const group = groups.get(groupId);
      group.meta = {
        ...group.meta,
        ...meta,
      };
      if (meta.order !== undefined) {
        group.order = meta.order;
      }
    }
    return groups.get(groupId);
  }

  function registerFeature(groupId, feature) {
    if (!feature || !feature.id) {
      throw new Error('[ControlFeatureRegistry] feature.id 必须存在');
    }
    if (featureIndex.has(feature.id)) {
      console.warn(`[ControlFeatureRegistry] feature.id=\"${feature.id}\" 已存在，忽略重复注册`);
      return;
    }
    const group = ensureGroup(groupId, feature.groupMeta);
    group.features.push(feature);
    featureIndex.set(feature.id, feature);
  }

  function getGroups() {
    const orderedGroups = Array.from(groups.values()).sort((a, b) => a.order - b.order);
    return orderedGroups.map((group) => ({
      ...group,
      features: group.features.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    }));
  }

  window.ControlFeatureRegistry = {
    ensureGroup,
    registerFeature,
    getGroups,
    getFeatureById(id) {
      return featureIndex.get(id);
    },
  };
})();

