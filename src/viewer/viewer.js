/* netdia viewer runtime. No dependencies; three.js is lazy-imported only
 * when the 3D tab is first opened, so the 2D layers open instantly. */
(function () {
  'use strict';

  var P = window.NETDIA;
  var stage = document.getElementById('nd-stage');
  var rail = document.getElementById('nd-rail');
  var inspector = document.getElementById('nd-inspector');
  var body = document.getElementById('nd-body');
  var legendEl = document.getElementById('nd-legend');
  var zoomEl = document.getElementById('nd-zoom');
  var search = document.getElementById('nd-search');

  var current = P.layers[0].id;
  var view = { scale: 1, x: 0, y: 0 };
  var detailMode = 'auto';   // auto | full | mid | low
  var detailEl = document.getElementById('nd-detail');
  var scene3d = null;
  var loading3d = false;

  /* ---- layer switching ---------------------------------------------- */

  function layerById(id) {
    for (var i = 0; i < P.layers.length; i++) if (P.layers[i].id === id) return P.layers[i];
    return null;
  }

  function show(id) {
    current = id;
    var tabs = rail.querySelectorAll('.nd-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i].dataset.layer === id));
    }
    var views = stage.querySelectorAll('.nd-view');
    for (var j = 0; j < views.length; j++) {
      views[j].hidden = views[j].dataset.layer !== id;
    }
    if (id === '3d') {
      renderLegend(null);
      mount3d();
    } else {
      renderLegend(layerById(id));
      fit();
    }
    closeInspector();
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }

  rail.addEventListener('click', function (e) {
    var tab = e.target.closest('.nd-tab');
    if (tab) show(tab.dataset.layer);
  });

  /* ---- pan and zoom --------------------------------------------------- */

  function pane() {
    return stage.querySelector('.nd-view:not([hidden]) .nd-pan');
  }

  function applyTransform() {
    var p = pane();
    if (!p) return;
    p.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
    zoomEl.textContent = Math.round(view.scale * 100) + '%';
    applyDetail();
  }

  /* ---- level of detail ------------------------------------------------ */

  // Thresholds are set where the smallest text stops being readable rather
  // than by taste: a 7.5px vendor mark is gone by 0.85, and a 6-unit port
  // is a smudge below 0.45.
  function levelForZoom(scale) {
    if (scale >= 0.85) return 'full';
    if (scale >= 0.45) return 'mid';
    return 'low';
  }

  function applyDetail() {
    var level = detailMode === 'auto' ? levelForZoom(view.scale) : detailMode;
    if (stage.dataset.detail !== level) stage.dataset.detail = level;
  }

  if (detailEl) {
    detailEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      detailMode = b.dataset.level;
      var all = detailEl.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) {
        all[i].setAttribute('aria-pressed', String(all[i].dataset.level === detailMode));
      }
      applyDetail();
    });
  }

  function fit() {
    var p = pane();
    if (!p) return;
    var svg = p.querySelector('svg');
    if (!svg) return;
    var sw = svg.viewBox.baseVal.width || svg.width.baseVal.value;
    var sh = svg.viewBox.baseVal.height || svg.height.baseVal.value;
    var r = stage.getBoundingClientRect();
    var pad = 28;
    view.scale = Math.min((r.width - pad * 2) / sw, (r.height - pad * 2) / sh, 1.6);
    view.x = (r.width - sw * view.scale) / 2;
    view.y = (r.height - sh * view.scale) / 2;
    applyTransform();
  }

  var drag = null;
  var panned = false;
  var pending = null;
  function schedule() {
    if (pending !== null) return;
    pending = requestAnimationFrame(function () {
      pending = null;
      applyTransform();
    });
  }
  stage.addEventListener('pointerdown', function (e) {
    if (current === '3d') return;
    if (e.target.closest('.nd-node')) return;
    var p = pane();
    if (!p) return;
    // A cable is a legitimate pan handle as well as a click target, so the
    // gesture is only committed to panning once the pointer has travelled
    // further than a hand tremor.
    drag = { x: e.clientX - view.x, y: e.clientY - view.y, x0: e.clientX, y0: e.clientY, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) <= 4) return;
      drag.moved = true;
      var pd = pane();
      if (pd) pd.dataset.grabbing = 'true';
    }
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    // A pointer can fire far faster than the display refreshes; coalescing
    // to one transform per frame keeps a drag from queueing repaints.
    schedule();
  });
  stage.addEventListener('pointerup', function (e) {
    panned = !!(drag && drag.moved);
    drag = null;
    var p = pane();
    if (p) p.dataset.grabbing = 'false';
    stage.releasePointerCapture(e.pointerId);
  });
  stage.addEventListener('wheel', function (e) {
    if (current === '3d') return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    var mx = e.clientX - r.left;
    var my = e.clientY - r.top;
    var next = Math.min(4, Math.max(0.15, view.scale * (1 - Math.sign(e.deltaY) * 0.12)));
    view.x = mx - ((mx - view.x) / view.scale) * next;
    view.y = my - ((my - view.y) / view.scale) * next;
    view.scale = next;
    schedule();
  }, { passive: false });

  document.getElementById('nd-fit').addEventListener('click', fit);
  window.addEventListener('resize', function () {
    if (current === '3d') { if (scene3d) scene3d.resize(); } else { fit(); }
  });

  /* ---- selection and inspector --------------------------------------- */

  stage.addEventListener('click', function (e) {
    // A pan that happens to end over a cable is not a click on that cable.
    if (panned) { panned = false; return; }
    var node = e.target.closest('.nd-node');
    if (node) { select(node.dataset.node); return; }
    var edge = e.target.closest('.nd-edge');
    if (edge) selectEdge(edge.dataset.edge);
  });
  stage.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var node = e.target.closest('.nd-node');
    if (node) {
      e.preventDefault();
      select(node.dataset.node);
      return;
    }
    var edge = e.target.closest('.nd-edge');
    if (edge) {
      e.preventDefault();
      selectEdge(edge.dataset.edge);
    }
  });
  stage.addEventListener('netdia:select', function (e) {
    if (e.detail && e.detail.nodeId) select(e.detail.nodeId, e.detail.layer);
    else closeInspector();
  });

  function findNode(id, layerId) {
    var layers = layerId ? [layerById(layerId)] : P.layers;
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (!l || !l.nodes) continue;
      for (var j = 0; j < l.nodes.length; j++) if (l.nodes[j].id === id) return l.nodes[j];
    }
    return null;
  }

  function findEdge(id, layerId) {
    var layers = layerId ? [layerById(layerId)] : P.layers;
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (!l || !l.edges) continue;
      for (var j = 0; j < l.edges.length; j++) if (l.edges[j].id === id) return { edge: l.edges[j], layer: l };
    }
    return null;
  }

  function labelOf(layer, id) {
    var nodes = (layer && layer.nodes) || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i].label;
    return id;
  }

  function select(id, layerId) {
    var node = findNode(id, layerId);
    if (!node) return;
    inspector.innerHTML = inspectorHtml(node);
    openInspector();
    highlight(id);
    if (scene3d) scene3d.highlight(id);
  }

  function selectEdge(id) {
    var found = findEdge(id, current) || findEdge(id);
    if (!found) return;
    inspector.innerHTML = edgeInspectorHtml(found.edge, found.layer);
    openInspector();
    highlightEdge(found.edge);
    // scene3d.highlight() resolves a node id against the 3D plates; an edge
    // id would silently clear the whole stack instead.
    if (scene3d) scene3d.highlight(null);
  }

  function openInspector() {
    body.dataset.inspector = 'open';
    inspector.querySelector('.nd-insp__close').addEventListener('click', closeInspector);
  }

  inspector.addEventListener('click', function (e) {
    var goto = e.target.closest('[data-goto]');
    if (goto) select(goto.dataset.goto);
  });

  function closeInspector() {
    body.dataset.inspector = 'closed';
    highlight(null);
    if (scene3d) scene3d.highlight(null);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeInspector(); search.value = ''; applySearch(''); }
  });

  function clearSelected(svg) {
    var sel = svg.querySelectorAll('.nd-edge[data-selected="1"]');
    for (var i = 0; i < sel.length; i++) sel[i].removeAttribute('data-selected');
  }

  function highlight(id) {
    var views = stage.querySelectorAll('.nd-view');
    for (var i = 0; i < views.length; i++) {
      var svg = views[i].querySelector('svg');
      if (!svg) continue;
      clearSelected(svg);
      if (!id) continue;
      var keep = { };
      keep[id] = true;
      var edges = svg.querySelectorAll('.nd-edge');
      for (var j = 0; j < edges.length; j++) {
        var hit = edges[j].dataset.a === id || edges[j].dataset.b === id;
        edges[j].dataset.match = hit ? '1' : '0';
        if (hit) { keep[edges[j].dataset.a] = true; keep[edges[j].dataset.b] = true; }
      }
      var nodes = svg.querySelectorAll('.nd-node');
      for (var k = 0; k < nodes.length; k++) {
        nodes[k].dataset.match = keep[nodes[k].dataset.node] ? '1' : '0';
      }
    }
    stage.dataset.focus = id ? 'on' : 'off';
  }

  function highlightEdge(edge) {
    var views = stage.querySelectorAll('.nd-view');
    for (var i = 0; i < views.length; i++) {
      var svg = views[i].querySelector('svg');
      if (!svg) continue;
      clearSelected(svg);
      var edges = svg.querySelectorAll('.nd-edge');
      for (var j = 0; j < edges.length; j++) {
        edges[j].dataset.match = edges[j].dataset.edge === edge.id ? '1' : '0';
      }
      // The isometric renderer splits one cable into a group per segment, all
      // sharing the same data-edge, so selection is never a single element.
      var picked = svg.querySelectorAll('[data-edge="' + edge.id + '"]');
      for (var m = 0; m < picked.length; m++) picked[m].dataset.selected = '1';
      var nodes = svg.querySelectorAll('.nd-node');
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k].dataset.node;
        nodes[k].dataset.match = n === edge.a || n === edge.b ? '1' : '0';
      }
    }
    stage.dataset.focus = 'on';
  }

  /* ---- search --------------------------------------------------------- */

  function haystack(node) {
    var parts = [node.id, node.label, node.sublabel || ''];
    var d = node.detail || {};
    if (d.mgmt_ip) parts.push(d.mgmt_ip);
    if (d.cidr) parts.push(d.cidr);
    if (d.vlan) parts.push('vlan' + d.vlan, String(d.vlan));
    if (d.name) parts.push(d.name);
    (d.interfaces || []).forEach(function (i) {
      parts.push(i.name, i.ip || '', (i.vlans || []).join(' '), i.description || '');
    });
    (d.services || []).forEach(function (s) { parts.push(s.name, String(s.port || '')); });
    return parts.join(' ').toLowerCase();
  }

  function applySearch(q) {
    q = q.trim().toLowerCase();
    if (!q) { stage.dataset.focus = 'off'; return; }
    var layer = layerById(current);
    if (!layer || !layer.nodes) return;
    var matched = {};
    layer.nodes.forEach(function (n) { if (haystack(n).indexOf(q) !== -1) matched[n.id] = true; });
    var svg = stage.querySelector('.nd-view:not([hidden]) svg');
    if (!svg) return;
    var nodes = svg.querySelectorAll('.nd-node');
    for (var i = 0; i < nodes.length; i++) nodes[i].dataset.match = matched[nodes[i].dataset.node] ? '1' : '0';
    var edges = svg.querySelectorAll('.nd-edge');
    for (var j = 0; j < edges.length; j++) {
      edges[j].dataset.match = matched[edges[j].dataset.a] && matched[edges[j].dataset.b] ? '1' : '0';
    }
    stage.dataset.focus = 'on';
  }

  search.addEventListener('input', function () { applySearch(search.value); });

  /* ---- inspector markup ----------------------------------------------- */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function kv(pairs) {
    var rows = pairs.filter(function (p) { return p[1]; })
      .map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; });
    return rows.length ? '<dl class="nd-kv">' + rows.join('') + '</dl>' : '';
  }

  function inspectorHead(kindLabel, title, micro) {
    return '<div class="nd-insp__head">' +
      '<button class="nd-insp__close" aria-label="Close details">&times;</button>' +
      '<div class="micro">' + esc(kindLabel) + '</div>' +
      '<h2>' + title + '</h2>' +
      (micro ? '<p>' + esc(micro) + '</p>' : '') +
      '</div>';
  }

  function goTo(id, label) {
    return '<button type="button" class="nd-pill" data-goto="' + esc(id) + '">' + esc(label) + '</button>';
  }

  function edgeInspectorHtml(edge, layer) {
    var d = edge.detail || {};
    var out = '';

    switch (edge.kind) {
      case 'cable': {
        var micro = [edge.media, edge.speed].filter(Boolean).join(' · ');
        out += inspectorHead('CABLE', 'Physical link', micro);
        out += '<div class="nd-sect"><h3>Run</h3>' +
          goTo(edge.a, labelOf(layer, edge.a)) +
          '<span class="nd-pill">' + esc(edge.aPort || '—') + '</span>' +
          '<span class="nd-pill">&harr;</span>' +
          goTo(edge.b, labelOf(layer, edge.b)) +
          '<span class="nd-pill">' + esc(edge.bPort || '—') + '</span>' +
          '</div>';
        if (d.lag) {
          out += '<div class="nd-sect"><h3>LAG &middot; ' + esc(d.lag) + '</h3>' +
            (d.memberLinks || []).map(function (m) {
              return '<div class="nd-iface"><b>' + esc(m.aPort) + ' &harr; ' + esc(m.bPort) + '</b>' +
                '<span>' + esc(m.speed || '') + '</span></div>';
            }).join('') + '</div>';
        }
        if (d.vlans && d.vlans.length) {
          out += '<div class="nd-sect"><h3>Carries VLANs</h3>' + d.vlans.map(function (v) {
            return '<span class="nd-pill">' + esc(v) + '</span>';
          }).join('') + '</div>';
        }
        break;
      }
      case 'vlan-member': {
        out += inspectorHead('VLAN MEMBERSHIP', 'VLAN ' + esc(d.vlan),
          d.tagged ? 'Tagged (trunk)' : 'Untagged (access)');
        var verb = d.svi ? 'is the gateway for' : 'is a member of';
        out += '<div class="nd-sect"><h3>Relationship</h3><p style="margin:0;font-size:11.5px;color:var(--nd-text-muted)">' +
          goTo(edge.a, labelOf(layer, edge.a)) + ' <b>' + verb + '</b> ' +
          goTo(edge.b, 'VLAN ' + d.vlan) +
          (d.vlanName ? ' <span class="nd-pill">' + esc(d.vlanName) + '</span>' : '') +
          '</p></div>';
        if (d.ports && d.ports.length) {
          out += '<div class="nd-sect"><h3>Via ports &middot; ' + d.ports.length + '</h3>' +
            d.ports.map(function (p) {
              return '<span class="nd-pill">' + esc(p) + '</span>';
            }).join('') + '</div>';
        }
        var vfacts = kv([['Subnet', d.subnet], ['Gateway', d.gateway]]);
        if (vfacts) out += '<div class="nd-sect"><h3>Addressing</h3>' + vfacts + '</div>';
        break;
      }
      case 'attachment': {
        out += inspectorHead('INTERFACE ATTACHMENT', esc(edge.label || ''), d.networkName || '');
        out += '<div class="nd-sect"><h3>Relationship</h3><p style="margin:0;font-size:11.5px;color:var(--nd-text-muted)">' +
          goTo(edge.a, labelOf(layer, edge.a)) +
          '<span class="nd-pill">' + esc(edge.aPort || '') + '</span>' +
          '<span class="nd-pill">' + esc(edge.label || '') + '</span>' +
          ' <b>attaches to</b> ' + goTo(edge.b, d.cidr || labelOf(layer, edge.b)) +
          '</p></div>';
        var afacts = kv([
          ['VRF', d.vrf],
          ['Role', d.gateway ? 'Default gateway for ' + (d.cidr || '') : ''],
        ]);
        if (afacts) out += '<div class="nd-sect"><h3>Facts</h3>' + afacts + '</div>';
        break;
      }
      default: {
        var rk = String(d.routingKind || 'static').toUpperCase();
        out += inspectorHead('ROUTING ADJACENCY', 'Route',
          rk + (d.bidirectional ? ' (bidirectional)' : ''));
        out += '<div class="nd-sect"><h3>Relationship</h3><p style="margin:0;font-size:11.5px;color:var(--nd-text-muted)">' +
          goTo(edge.a, labelOf(layer, edge.a)) +
          ' <b>' + (d.bidirectional ? 'peers with' : 'routes via') + '</b> ' +
          goTo(edge.b, labelOf(layer, edge.b)) +
          '</p></div>';
        if (d.detail) {
          out += '<div class="nd-sect"><h3>Description</h3>' +
            '<p style="margin:0;font-size:11.5px;color:var(--nd-text-muted)">' + esc(d.detail) + '</p></div>';
        }
      }
    }

    return out;
  }

  function inspectorHtml(node) {
    var d = node.detail || {};
    var out = '';

    out += '<div class="nd-insp__head">' +
      '<button class="nd-insp__close" aria-label="Close details">&times;</button>' +
      '<div class="micro">' + esc(node.kind === 'device' ? d.role || 'device' : node.kind) + '</div>' +
      '<h2>' + esc(node.label) + '</h2>' +
      (node.sublabel ? '<p>' + esc(node.sublabel) + '</p>' : '') +
      '</div>';

    if (node.kind === 'device') {
      var facts = kv([
        ['Vendor', d.vendor && d.vendor !== 'generic' ? d.vendor : ''],
        ['Model', d.model], ['OS', d.os], ['Site', d.site], ['Zone', d.zone],
        ['Mgmt IP', d.mgmt_ip],
      ]);
      if (facts) out += '<div class="nd-sect"><h3>Identity</h3>' + facts + '</div>';

      var ifs = d.interfaces || [];
      if (ifs.length) {
        out += '<div class="nd-sect"><h3>Interfaces &middot; ' + ifs.length + '</h3>' +
          ifs.map(function (i) {
            var right = i.ip || (i.vlans && i.vlans.length ? 'VLAN ' + i.vlans.join(',') : '') || i.speed || '';
            return '<div class="nd-iface"><b>' + esc(i.name) + '</b><span>' + esc(right) + '</span>' +
              (i.description ? '<small>' + esc(i.description) + '</small>' : '') + '</div>';
          }).join('') + '</div>';
      }

      var svcs = d.services || [];
      if (svcs.length) {
        out += '<div class="nd-sect"><h3>Services</h3>' + svcs.map(function (s) {
          return '<span class="nd-pill">' + esc(s.name) + (s.port ? ':' + s.port : '') + '</span>';
        }).join('') + '</div>';
      }

      if (d.tags && d.tags.length) {
        out += '<div class="nd-sect"><h3>Tags</h3>' +
          d.tags.map(function (t) { return '<span class="nd-pill">' + esc(t) + '</span>'; }).join('') + '</div>';
      }
      if (d.notes) out += '<div class="nd-sect"><h3>Notes</h3><p style="margin:0;font-size:11.5px;color:var(--nd-text-muted)">' + esc(d.notes) + '</p></div>';
    } else if (node.kind === 'vlan') {
      out += '<div class="nd-sect"><h3>Broadcast domain</h3>' + kv([
        ['VLAN', d.vlan], ['Name', d.name], ['Subnet', d.subnet],
        ['Gateway', d.gateway], ['Zone', d.zone], ['Purpose', d.purpose],
      ]) + '</div>';
      if (d.members && d.members.length) {
        out += '<div class="nd-sect"><h3>Members &middot; ' + d.members.length + '</h3>' +
          d.members.map(function (m) { return '<span class="nd-pill">' + esc(m) + '</span>'; }).join('') + '</div>';
      }
    } else {
      out += '<div class="nd-sect"><h3>IP network</h3>' + kv([
        ['CIDR', d.cidr], ['Name', d.name], ['VLAN', d.vlan],
        ['Gateway', d.gateway], ['VRF', d.vrf], ['Zone', d.zone],
        ['DHCP', d.dhcp ? 'yes' : ''],
      ]) + '</div>';
      var att = d.attached || [];
      if (att.length) {
        out += '<div class="nd-sect"><h3>Attached &middot; ' + att.length + '</h3>' + att.map(function (a) {
          return '<div class="nd-iface"><b>' + esc(a.device) + '</b><span>' + esc(a.ip) + '</span>' +
            '<small>' + esc(a.iface) + (a.gateway ? ' &middot; gateway' : '') + '</small></div>';
        }).join('') + '</div>';
      }
    }

    return out;
  }

  /* ---- legend --------------------------------------------------------- */

  function renderLegend(layer) {
    if (!layer) { legendEl.innerHTML = '<span>Drag to orbit &middot; scroll to zoom &middot; click a plate to inspect</span>'; return; }
    legendEl.innerHTML = layer.legend.map(function (l) {
      return '<span style="color:' + esc(l.color) + '"><i></i><span style="color:var(--nd-text-muted)">' +
        esc(l.label) + '</span></span>';
    }).join('');
  }

  /* ---- export --------------------------------------------------------- */

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function activeSvg() {
    return stage.querySelector('.nd-view:not([hidden]) svg');
  }

  document.getElementById('nd-svg').addEventListener('click', function () {
    if (current === '3d') return;
    var svg = activeSvg();
    if (!svg) return;
    download(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }),
      P.slug + '.' + current + '.svg');
  });

  document.getElementById('nd-png').addEventListener('click', function () {
    if (current === '3d') {
      var c3 = document.getElementById('nd-canvas3d');
      if (scene3d) scene3d.render();
      c3.toBlob(function (b) { download(b, P.slug + '.3d.png'); });
      return;
    }
    var svg = activeSvg();
    if (!svg) return;
    var w = svg.viewBox.baseVal.width;
    var h = svg.viewBox.baseVal.height;
    var scale = 2;
    var img = new Image();
    var src = 'data:image/svg+xml;base64,' +
      btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = w * scale;
      c.height = h * scale;
      var ctx = c.getContext('2d');
      ctx.fillStyle = P.theme.bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (b) { download(b, P.slug + '.' + current + '.png'); });
    };
    img.src = src;
  });

  document.getElementById('nd-print').addEventListener('click', function () { window.print(); });

  /* ---- 3D ------------------------------------------------------------- */

  function mount3d() {
    if (scene3d) { scene3d.resize(); return; }
    if (loading3d) return;
    var src = document.getElementById('nd-3d-src');
    if (!src) return;
    loading3d = true;
    var note = document.getElementById('nd-3d-note');
    note.textContent = 'Loading 3D…';
    var blob = new Blob([src.textContent], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    import(url).then(function (mod) {
      scene3d = mod.createScene(document.getElementById('nd-canvas3d'), {
        // Only the three real layers become floors; the isometric tab is
        // another drawing of L1, not a fourth layer.
        layers: P.layers.filter(function (l) { return ['l1', 'l2', 'l3'].indexOf(l.id) !== -1; }),
        theme: P.theme,
      });
      window.NETDIA_SCENE = scene3d;
      note.textContent = '';
      URL.revokeObjectURL(url);
    }).catch(function (err) {
      note.textContent = '3D unavailable: ' + err.message;
      loading3d = false;
    });
  }

  /* ---- boot ------------------------------------------------------------ */

  var hash = location.hash.replace('#', '');
  show(layerById(hash) || hash === '3d' ? hash : P.layers[0].id);
  requestAnimationFrame(fit);
})();
