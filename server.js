const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function makeProductImage(name, category, color) {
  const bgMap = { Black:'#1f1f1f', White:'#f5f2eb', Beige:'#d8c5a8', Champagne:'#ead8b8', Brown:'#7a5138', Grey:'#b8b8b8', Blue:'#4c79a8', Green:'#4f7d67', Pink:'#d9a7b0' };
  const bg = bgMap[color] || '#e9e2d9';
  const ink = ['Black','Brown','Blue','Green'].includes(color) ? '#ffffff' : '#171615';
  const label = String(name || 'AURA').replace(/[<>&"]/g, '');
  const cat = String(category || 'Fashion').replace(/[<>&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1125" viewBox="0 0 900 1125">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#fbfaf7"/></linearGradient></defs>
    <rect width="900" height="1125" fill="url(#g)"/>
    <circle cx="450" cy="330" r="155" fill="${ink}" opacity="0.08"/>
    <rect x="225" y="500" width="450" height="430" rx="70" fill="${ink}" opacity="0.10"/>
    <text x="450" y="985" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" font-weight="700" fill="${ink}">${label}</text>
    <text x="450" y="1038" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" letter-spacing="6" fill="${ink}" opacity="0.70">${cat.toUpperCase()}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function cleanImageUrl(imageUrl, name, category, color) {
  const raw = String(imageUrl || '').trim();
  if (!raw || raw.includes('images.unsplash.com') || raw.includes('via.placeholder.com')) return makeProductImage(name, category, color);
  return raw;
}

function toBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function handleError(res, error, fallback = 'Server error') {
  console.error(error);
  return res.status(500).json({ error: error?.message || fallback });
}

async function getUserById(id) {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

async function logAction(userId, action, details, req = null) {
  try {
    const user = userId ? await getUserById(userId) : null;
    await supabase.from('activity_logs').insert({
      user_id: userId || null,
      user_name: user?.name || 'System',
      action,
      details,
      ip_address: req?.ip || null
    });
  } catch (err) {
    console.error('Log failed:', err.message);
  }
}

async function queueEmail({ to, name, subject, bodyText, bodyHtml, type = 'general', orderId = null, invoiceId = null, refundId = null }) {
  const { data, error } = await supabase.from('email_queue').insert({
    type,
    recipient_email: to,
    recipient_name: name || null,
    subject,
    body_text: bodyText || null,
    body_html: bodyHtml || null,
    status: 'pending',
    related_order_id: orderId,
    related_invoice_id: invoiceId,
    related_refund_id: refundId
  }).select('*').single();
  if (error) throw error;
  return data;
}

async function getOrderDetails(orderId) {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*, customer:users(*)')
    .eq('id', orderId)
    .single();

  if (orderError || !order) return null;

  const [{ data: items }, { data: tracking }, { data: refunds }, { data: invoice }] = await Promise.all([
    supabase.from('order_items').select('*, product:products(*)').eq('order_id', order.id).order('id'),
    supabase.from('order_tracking').select('*').eq('order_id', order.id).order('created_at'),
    supabase.from('refund_requests').select('*').eq('order_id', order.id).order('requested_at', { ascending: false }),
    supabase.from('invoices').select('*').eq('order_id', order.id).maybeSingle()
  ]);

  return {
    ...order,
    invoice_number: invoice?.invoice_no || order.order_no,
    customer: order.customer || {},
    items: (items || []).map(i => ({
      ...i,
      product: i.product || { id: i.product_id, name: i.product_name, sku: i.sku, color: i.color }
    })),
    tracking: tracking || [],
    refunds: refunds || [],
    invoice: invoice || null
  };
}

async function buildInvoiceHtml(orderId) {
  const data = await getOrderDetails(orderId);
  if (!data) return '';
  const rows = data.items.map(i => `<tr><td>${i.product_name || i.product?.name || ('Product #'+i.product_id)}</td><td>${i.size || '-'}</td><td>${i.quantity}</td><td>AED ${Number(i.price).toFixed(2)}</td><td>AED ${Number(i.line_total || (Number(i.price) * Number(i.quantity))).toFixed(2)}</td></tr>`).join('');
  const invoiceNo = data.invoice?.invoice_no || data.invoice_number || data.order_no || `INV-${String(data.id).padStart(5, '0')}`;
  return `<!DOCTYPE html><html><head><title>Invoice ${invoiceNo}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#171615}.box{max-width:850px;margin:auto;border:1px solid #e6ddd2;border-radius:18px;padding:28px}h1{margin:0 0 6px}.muted{color:#777}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{border-bottom:1px solid #eee;padding:12px;text-align:left}th{background:#f7f3ed}.total{text-align:right;font-size:22px;font-weight:bold;margin-top:20px}.badge{display:inline-block;padding:8px 12px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:bold}</style></head><body><div class="box"><h1>AURA Invoice</h1><p class="muted">Invoice No: <b>${invoiceNo}</b><br>Order No: <b>${data.order_no || ('#'+data.id)}</b><br>Date: ${new Date(data.created_at).toLocaleString()}</p><p><b>Bill To:</b><br>${data.customer?.name || data.shipping_name || ''}<br>${data.customer?.email || ''}<br>${data.shipping_phone || ''}<br>${data.shipping_address || ''}, ${data.shipping_city || ''}, ${data.shipping_country || ''}</p><p><span class="badge">Payment: ${(data.payment_status||'').toUpperCase()}</span></p><table><thead><tr><th>Item</th><th>Size</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Grand Total: AED ${Number(data.total_amount).toFixed(2)}</div><p class="muted">This invoice is system generated.</p></div></body></html>`;
}

async function restoreStockForOrder(orderId, adminUserId) {
  const { data: items, error } = await supabase.from('order_items').select('*').eq('order_id', orderId);
  if (error) throw error;

  for (const item of items || []) {
    if (!item.product_id) continue;
    const { data: product, error: productError } = await supabase.from('products').select('*').eq('id', item.product_id).single();
    if (productError || !product) continue;
    const previous = Number(product.stock || 0);
    const newStock = previous + Number(item.quantity || 0);
    await supabase.from('products').update({ stock: newStock }).eq('id', item.product_id);
    await supabase.from('stock_movements').insert({
      product_id: item.product_id,
      movement_type: 'refund_restock',
      quantity: Number(item.quantity || 0),
      previous_stock: previous,
      new_stock: newStock,
      reference_type: 'order_refund',
      reference_id: orderId,
      note: `Refund stock restored for order #${orderId}`,
      created_by: adminUserId || null
    });
  }
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error:'Please login to continue' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).json({ error:'Admin access required' });
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy:false }));
app.use(cors({ origin:true, credentials:true }));
app.use(express.json({ limit:'10mb' }));
app.use(express.urlencoded({ extended:true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'aura_demo_secret_change_this',
  resave:false,
  saveUninitialized:false,
  cookie:{ httpOnly:true, sameSite:'lax', secure: process.env.NODE_ENV === 'production' ? true : 'auto', maxAge:1000*60*60*24*7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth
app.post('/api/auth/register', async (req,res) => {
  try {
    const { name, email, password } = req.body;
    if(!name || !email || !password) return res.status(400).json({ error:'All fields are required' });

    const { data: existing } = await supabase.from('users').select('id').ilike('email', String(email).trim()).maybeSingle();
    if(existing) return res.status(409).json({ error:'Email already registered' });

    const { data: user, error } = await supabase.from('users').insert({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      password,
      role: 'customer',
      is_active: true
    }).select('*').single();
    if (error) throw error;

    req.session.user = { id:user.id, name:user.name, email:user.email, role:user.role };
    await logAction(user.id, 'CUSTOMER_REGISTER', `New customer registered: ${user.name} (${user.email})`, req);
    req.session.save(err => err ? res.status(500).json({ error:'Session save failed' }) : res.json({ user:req.session.user }));
  } catch (error) { return handleError(res, error); }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .ilike('email', String(email || '').trim())
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if(!user || user.password !== password) return res.status(401).json({ error:'Invalid email or password' });

    req.session.user = { id:user.id, name:user.name, email:user.email, role:user.role };
    await logAction(user.id, 'LOGIN', `${user.name} logged in`, req);
    req.session.save(err => err ? res.status(500).json({ error:'Session save failed' }) : res.json({ user:req.session.user }));
  } catch (error) { return handleError(res, error); }
});

app.post('/api/auth/logout', (req,res) => req.session.destroy(() => res.json({ message:'Logged out' })));
app.get('/api/auth/me', (req,res) => res.json({ user:req.session.user || null }));

// Storefront
app.get('/api/products', async (req,res) => {
  try {
    const { q, category, size, color, min, max, sort } = req.query;
    let query = supabase.from('products').select('*').eq('is_active', true);
    if (category) query = query.eq('category', category);
    if (color) query = query.eq('color', color);
    if (min) query = query.gte('price', Number(min));
    if (max) query = query.lte('price', Number(max));
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,brand.ilike.%${q}%,category.ilike.%${q}%`);
    if (sort === 'price_asc') query = query.order('price', { ascending:true });
    else if (sort === 'price_desc') query = query.order('price', { ascending:false });
    else query = query.order('created_at', { ascending:false });

    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];
    if (size) rows = rows.filter(p => String(p.sizes || '').split(',').map(s => s.trim()).includes(String(size)));
    rows = rows.map(p => ({ ...p, image_url: cleanImageUrl(p.image_url, p.name, p.category, p.color) }));
    res.json(rows);
  } catch (error) { return handleError(res, error); }
});

app.get('/api/products/filters', async (req,res) => {
  try {
    const { data, error } = await supabase.from('products').select('category,color,sizes').eq('is_active', true);
    if (error) throw error;
    const categories = [...new Set((data || []).map(p => p.category).filter(Boolean))].sort();
    const colors = [...new Set((data || []).map(p => p.color).filter(Boolean))].sort();
    const sizes = [...new Set((data || []).flatMap(p => String(p.sizes || '').split(',').map(s => s.trim()).filter(Boolean)))].sort();
    res.json({ categories, colors, sizes: sizes.length ? sizes : ['XS','S','M','L','XL','XXL','One Size'] });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/products/:id', async (req,res) => {
  try {
    const { data: p, error } = await supabase.from('products').select('*').eq('id', req.params.id).eq('is_active', true).single();
    if(error || !p) return res.status(404).json({ error:'Product not found' });
    res.json({ ...p, image_url: cleanImageUrl(p.image_url, p.name, p.category, p.color) });
  } catch (error) { return handleError(res, error); }
});

// Cart and Checkout
app.get('/api/cart', requireLogin, async (req,res) => {
  try {
    const { data, error } = await supabase
      .from('cart_items')
      .select('id, quantity, size, product:products(*)')
      .eq('user_id', req.session.user.id)
      .order('created_at', { ascending:false });
    if (error) throw error;
    res.json((data || []).map(c => ({
      cart_id: c.id,
      quantity: c.quantity,
      size: c.size,
      product_id: c.product?.id,
      name: c.product?.name,
      price: c.product?.price,
      image_url: cleanImageUrl(c.product?.image_url, c.product?.name, c.product?.category, c.product?.color),
      stock: c.product?.stock
    })));
  } catch (error) { return handleError(res, error); }
});

app.post('/api/cart', requireLogin, async (req,res) => {
  try {
    const { product_id, quantity=1, size='M' } = req.body;
    const productId = Number(product_id);
    const qty = Math.max(1, Number(quantity || 1));
    const { data: product, error: productError } = await supabase.from('products').select('*').eq('id', productId).eq('is_active', true).single();
    if(productError || !product) return res.status(404).json({ error:'Product not found' });

    const { data: existing } = await supabase
      .from('cart_items')
      .select('*')
      .eq('user_id', req.session.user.id)
      .eq('product_id', productId)
      .eq('size', size)
      .maybeSingle();

    if(existing) {
      const { error } = await supabase.from('cart_items').update({ quantity: Number(existing.quantity) + qty }).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('cart_items').insert({ user_id:req.session.user.id, product_id:productId, quantity:qty, size });
      if (error) throw error;
    }
    res.json({ message:'Added to cart' });
  } catch (error) { return handleError(res, error); }
});

app.put('/api/cart/:id', requireLogin, async (req,res) => {
  try {
    const quantity = Math.max(1, Number(req.body.quantity || 1));
    const { error } = await supabase.from('cart_items').update({ quantity }).eq('id', req.params.id).eq('user_id', req.session.user.id);
    if (error) throw error;
    res.json({ message:'Cart updated' });
  } catch (error) { return handleError(res, error); }
});

app.delete('/api/cart/:id', requireLogin, async (req,res) => {
  try {
    const { error } = await supabase.from('cart_items').delete().eq('id', req.params.id).eq('user_id', req.session.user.id);
    if (error) throw error;
    res.json({ message:'Removed' });
  } catch (error) { return handleError(res, error); }
});

app.post('/api/orders/checkout', requireLogin, async (req,res) => {
  try {
    const { address, city, country, phone, saveAddress, customer_note } = req.body;
    if(!address || !city || !phone) return res.status(400).json({ error:'Phone, address and city are required' });

    const { data: cart, error: cartError } = await supabase
      .from('cart_items')
      .select('*, product:products(*)')
      .eq('user_id', req.session.user.id);
    if (cartError) throw cartError;
    if(!cart?.length) return res.status(400).json({ error:'Cart is empty' });

    const missing = cart.find(i => !i.product || !i.product.is_active);
    if(missing) return res.status(400).json({ error:'One item is no longer available' });
    const insufficient = cart.find(i => Number(i.product.stock) < Number(i.quantity));
    if(insufficient) return res.status(400).json({ error:`Insufficient stock for ${insufficient.product.name}. Available: ${insufficient.product.stock}` });

    const customer = await getUserById(req.session.user.id);
    const subtotal = cart.reduce((s,i)=>s + Number(i.product.price)*Number(i.quantity),0);
    const total = subtotal;

    const { data: order, error: orderError } = await supabase.from('orders').insert({
      user_id: req.session.user.id,
      subtotal_amount: subtotal,
      total_amount: total,
      currency: 'AED',
      status: 'pending',
      payment_status: 'paid',
      payment_method: 'demo',
      shipping_name: customer?.name || req.session.user.name,
      shipping_phone: phone,
      shipping_address: address,
      shipping_city: city,
      shipping_country: country || 'United Arab Emirates',
      customer_note: customer_note || null
    }).select('*').single();
    if (orderError) throw orderError;

    const orderItems = cart.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product.name,
      sku: item.product.sku,
      size: item.size,
      color: item.product.color,
      quantity: item.quantity,
      price: item.product.price,
      line_total: Number(item.product.price) * Number(item.quantity)
    }));
    const { data: insertedItems, error: itemError } = await supabase.from('order_items').insert(orderItems).select('*');
    if (itemError) throw itemError;

    for (const item of cart) {
      const previous = Number(item.product.stock || 0);
      const newStock = previous - Number(item.quantity || 0);
      await supabase.from('products').update({ stock: newStock }).eq('id', item.product_id);
      await supabase.from('stock_movements').insert({
        product_id: item.product_id,
        movement_type: 'order_deduction',
        quantity: Number(item.quantity || 0),
        previous_stock: previous,
        new_stock: newStock,
        reference_type: 'order',
        reference_id: order.id,
        note: `Stock deducted for ${order.order_no || 'order #' + order.id}`,
        created_by: req.session.user.id
      });
    }

    const { data: invoice, error: invoiceError } = await supabase.from('invoices').insert({
      order_id: order.id,
      user_id: req.session.user.id,
      currency: 'AED',
      subtotal_amount: subtotal,
      total_amount: total,
      status: 'paid',
      billing_name: customer?.name || req.session.user.name,
      billing_email: customer?.email || req.session.user.email,
      billing_phone: phone,
      billing_address: `${address}, ${city}, ${country || 'United Arab Emirates'}`
    }).select('*').single();
    if (invoiceError) throw invoiceError;

    const invoiceItems = (insertedItems || []).map(i => ({
      invoice_id: invoice.id,
      order_item_id: i.id,
      description: `${i.product_name}${i.size ? ' - Size ' + i.size : ''}`,
      quantity: i.quantity,
      unit_price: i.price,
      line_total: i.line_total
    }));
    if (invoiceItems.length) {
      const { error } = await supabase.from('invoice_items').insert(invoiceItems);
      if (error) throw error;
    }

    await supabase.from('order_tracking').insert({
      order_id: order.id,
      status: 'pending',
      message: 'Order placed successfully. Payment confirmed in demo mode.',
      updated_by: req.session.user.id
    });

    if(saveAddress){
      await supabase.from('users').update({ address, city, country: country || 'United Arab Emirates', phone }).eq('id', req.session.user.id);
    }

    await supabase.from('cart_items').delete().eq('user_id', req.session.user.id);

    await queueEmail({
      to: customer?.email || req.session.user.email,
      name: customer?.name || req.session.user.name,
      subject: `Order Confirmation - ${order.order_no || '#'+order.id}`,
      bodyText: `Dear ${customer?.name || 'Customer'},\n\nYour order ${order.order_no || '#'+order.id} has been confirmed. Invoice: ${invoice.invoice_no}. Total: AED ${Number(total).toFixed(2)}.\n\nThank you for shopping with AURA.`,
      type: 'order_confirmation',
      orderId: order.id,
      invoiceId: invoice.id
    });

    await logAction(req.session.user.id, 'ORDER_CREATE', `Order ${order.order_no || '#'+order.id} / ${invoice.invoice_no} created with ${cart.length} item(s), total AED ${Number(total).toFixed(2)}. Confirmation email queued.`, req);
    req.session.save(err => err ? res.status(500).json({ error:'Session save failed' }) : res.json({ url:`/success?order=${order.id}&demo=true` }));
  } catch (error) { return handleError(res, error); }
});

app.get('/api/orders/my', requireLogin, async (req,res) => {
  try {
    const { data: orders, error } = await supabase.from('orders').select('id').eq('user_id', req.session.user.id).order('created_at', { ascending:false });
    if (error) throw error;
    const details = [];
    for (const o of orders || []) details.push(await getOrderDetails(o.id));
    res.json(details.filter(Boolean));
  } catch (error) { return handleError(res, error); }
});

app.get('/api/orders/:id/invoice', requireLogin, async (req,res) => {
  try {
    const data = await getOrderDetails(req.params.id);
    if(!data) return res.status(404).send('Invoice not found');
    if(req.session.user.role !== 'admin' && Number(data.user_id) !== Number(req.session.user.id)) return res.status(403).send('Access denied');
    res.setHeader('Content-Type','text/html');
    res.send(await buildInvoiceHtml(req.params.id));
  } catch (error) { return res.status(500).send(error.message); }
});

app.post('/api/orders/:id/refund-request', requireLogin, async (req,res) => {
  try {
    const orderId = Number(req.params.id);
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).eq('user_id', req.session.user.id).maybeSingle();
    if(!order) return res.status(404).json({ error:'Order not found' });
    if(order.payment_status === 'refunded') return res.status(400).json({ error:'Order already refunded' });

    const { data: existing } = await supabase.from('refund_requests').select('*').eq('order_id', orderId).in('status', ['requested','approved']).maybeSingle();
    if(existing) return res.status(409).json({ error:'Refund request already exists' });

    const reason = String(req.body.reason || 'Customer requested refund').trim();
    const { data: refund, error } = await supabase.from('refund_requests').insert({
      order_id: orderId,
      user_id: req.session.user.id,
      reason,
      status: 'requested',
      requested_amount: Number(order.total_amount)
    }).select('*').single();
    if (error) throw error;

    await supabase.from('order_tracking').insert({ order_id: orderId, status:'refund_requested', message:reason, updated_by:req.session.user.id });
    await logAction(req.session.user.id, 'REFUND_REQUEST', `Refund requested for order #${orderId}: ${reason}`, req);
    res.json({ message:'Refund request submitted', refund });
  } catch (error) { return handleError(res, error); }
});

app.post('/api/orders/ticket', requireLogin, async (req,res) => {
  try {
    const { subject, message, order_id } = req.body;
    if(!subject || !message) return res.status(400).json({ error:'Subject and message required' });
    const { data: ticket, error } = await supabase.from('support_tickets').insert({
      user_id: req.session.user.id,
      order_id: order_id || null,
      subject,
      message,
      status: 'open'
    }).select('*').single();
    if (error) throw error;
    await logAction(req.session.user.id, 'SUPPORT_TICKET', `Support ticket #${ticket.id} created: ${subject}`, req);
    res.json({ message:'Support ticket created', ticket });
  } catch (error) { return handleError(res, error); }
});

// Admin Summary/Reports
app.get('/api/admin/summary', requireLogin, requireAdmin, async (req,res) => {
  try {
    const [{ data: orders }, { data: products }, { data: customers }, { data: tickets }, { data: logs }] = await Promise.all([
      supabase.from('orders').select('*, customer:users(name,email)').order('created_at', { ascending:false }),
      supabase.from('products').select('*').eq('is_active', true),
      supabase.from('users').select('*').eq('role', 'customer'),
      supabase.from('support_tickets').select('*'),
      supabase.from('activity_logs').select('*').order('created_at', { ascending:false }).limit(8)
    ]);
    const totalSales = (orders || []).reduce((s,o)=>s+Number(o.total_amount || 0),0);
    const lowStock = (products || []).filter(p=>Number(p.stock)<=Number(p.low_stock_limit || 10));
    res.json({
      totalSales,
      orderCount:(orders || []).length,
      productCount:(products || []).length,
      activeCustomers:(customers || []).length,
      openTickets:(tickets || []).filter(t=>t.status==='open').length,
      lowStockCount:lowStock.length,
      lowStock,
      recentOrders:(orders || []).slice(0,5).map(o=>({ ...o, customer:o.customer?.name, user_name:o.customer?.name, user_email:o.customer?.email })),
      recentLogs:logs || []
    });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/reports', requireLogin, requireAdmin, async (req,res) => {
  try {
    const [{ data: orders }, { data: products }, { data: orderItems }] = await Promise.all([
      supabase.from('orders').select('*'),
      supabase.from('products').select('*').eq('is_active', true),
      supabase.from('order_items').select('*')
    ]);
    const statuses = ['pending','processing','dispatched','delivered','cancelled'];
    const salesByStatus = statuses.map(status => ({ status, count:(orders || []).filter(o=>o.status===status).length }));
    const topProducts = (products || []).map(p => {
      const sold = (orderItems || []).filter(i=>Number(i.product_id)===Number(p.id)).reduce((s,i)=>s+Number(i.quantity),0);
      return { id:p.id, name:p.name, sold, revenue:sold*Number(p.price), stock:p.stock };
    }).sort((a,b)=>b.sold-a.sold);
    const dailySales = [];
    for(let i=6;i>=0;i--){
      const d = new Date(Date.now()-i*86400000);
      const key = d.toISOString().slice(0,10);
      const dayOrders = (orders || []).filter(o=>String(o.created_at).slice(0,10)===key);
      dailySales.push({ date:key, sales:dayOrders.reduce((s,o)=>s+Number(o.total_amount || 0),0), orders:dayOrders.length });
    }
    res.json({ salesByStatus, topProducts, dailySales });
  } catch (error) { return handleError(res, error); }
});

// Admin Orders
app.get('/api/admin/orders', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: orders, error } = await supabase.from('orders').select('id').order('created_at', { ascending:false });
    if (error) throw error;
    const rows = [];
    for (const o of orders || []) {
      const d = await getOrderDetails(o.id);
      if (d) rows.push({ ...d, user_name:d.customer?.name, user_email:d.customer?.email });
    }
    res.json(rows);
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/orders/:id/status', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { status, message } = req.body;
    const { data: order, error: findError } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if(findError || !order) return res.status(404).json({ error:'Order not found' });
    const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    await supabase.from('order_tracking').insert({ order_id:order.id, status, message:message || null, updated_by:req.session.user.id });
    await logAction(req.session.user.id, 'ORDER_UPDATE', `Order ${order.order_no || '#'+order.id} status changed from ${order.status} to ${status}${message ? ' | Note: '+message : ''}`, req);
    res.json({ message:'Order updated' });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/refunds', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: refunds, error } = await supabase.from('refund_requests').select('*, customer:users(*)').order('requested_at', { ascending:false });
    if (error) throw error;
    const rows = [];
    for (const r of refunds || []) rows.push({ ...r, amount:r.requested_amount, order:await getOrderDetails(r.order_id), customer:r.customer || {} });
    res.json(rows);
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/refunds/:id', requireLogin, requireAdmin, async (req,res) => {
  try {
    const action = String(req.body.action || '').toLowerCase();
    const note = String(req.body.note || '').trim();
    if(!['approve','reject'].includes(action)) return res.status(400).json({ error:'Action must be approve or reject' });

    const { data: refund, error: refundError } = await supabase.from('refund_requests').select('*').eq('id', req.params.id).single();
    if(refundError || !refund) return res.status(404).json({ error:'Refund request not found' });
    if(refund.status !== 'requested') return res.status(400).json({ error:'Refund already processed' });

    const order = await getOrderDetails(refund.order_id);
    if (action === 'approve') {
      const { data: updatedRefund, error } = await supabase.from('refund_requests').update({
        status:'approved',
        approved_amount: refund.requested_amount,
        admin_note: note || null,
        reviewed_by: req.session.user.id,
        reviewed_at: new Date().toISOString()
      }).eq('id', refund.id).select('*').single();
      if (error) throw error;
      await supabase.from('orders').update({ payment_status:'refunded', status:'cancelled' }).eq('id', refund.order_id);
      await supabase.from('invoices').update({ status:'refunded' }).eq('order_id', refund.order_id);
      await restoreStockForOrder(refund.order_id, req.session.user.id);
      await supabase.from('order_tracking').insert({ order_id:refund.order_id, status:'refunded', message:note || 'Refund approved and stock restored', updated_by:req.session.user.id });
      await queueEmail({
        to: order?.customer?.email,
        name: order?.customer?.name,
        subject: `Refund Approved - Order ${order?.order_no || '#'+refund.order_id}`,
        bodyText: `Your refund request for order ${order?.order_no || '#'+refund.order_id} has been approved. Amount: AED ${Number(refund.requested_amount).toFixed(2)}.`,
        type: 'refund_update',
        orderId: refund.order_id,
        refundId: refund.id
      });
      await logAction(req.session.user.id,'REFUND_APPROVE',`Refund approved for order #${refund.order_id}. Stock restored.`, req);
      return res.json({ message:'Refund updated', refund:updatedRefund });
    }

    const { data: updatedRefund, error } = await supabase.from('refund_requests').update({
      status:'rejected',
      admin_note: note || null,
      reviewed_by: req.session.user.id,
      reviewed_at: new Date().toISOString()
    }).eq('id', refund.id).select('*').single();
    if (error) throw error;
    await supabase.from('order_tracking').insert({ order_id:refund.order_id, status:'refund_rejected', message:note || 'Refund rejected', updated_by:req.session.user.id });
    await queueEmail({
      to: order?.customer?.email,
      name: order?.customer?.name,
      subject: `Refund Update - Order ${order?.order_no || '#'+refund.order_id}`,
      bodyText: `Your refund request for order ${order?.order_no || '#'+refund.order_id} has been reviewed. Status: Rejected. ${note}`,
      type: 'refund_update',
      orderId: refund.order_id,
      refundId: refund.id
    });
    await logAction(req.session.user.id,'REFUND_REJECT',`Refund rejected for order #${refund.order_id}. ${note}`, req);
    res.json({ message:'Refund updated', refund:updatedRefund });
  } catch (error) { return handleError(res, error); }
});

app.post('/api/admin/orders/:id/resend-email', requireLogin, requireAdmin, async (req,res) => {
  try {
    const data = await getOrderDetails(req.params.id);
    if(!data) return res.status(404).json({ error:'Order not found' });
    const email = await queueEmail({
      to: data.customer?.email,
      name: data.customer?.name,
      subject: `Order Confirmation - ${data.order_no || '#'+data.id}`,
      bodyText: `Dear ${data.customer?.name || 'Customer'},\n\nYour order ${data.order_no || '#'+data.id} invoice ${data.invoice?.invoice_no || ''} is confirmed. Total AED ${Number(data.total_amount).toFixed(2)}.`,
      type: 'order_confirmation',
      orderId: data.id,
      invoiceId: data.invoice?.id || null
    });
    await logAction(req.session.user.id,'EMAIL_RESEND',`Order confirmation email queued again for order #${data.id}`, req);
    res.json({ message:'Email queued', email });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/email-outbox', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data, error } = await supabase.from('email_queue').select('*').order('created_at', { ascending:false }).limit(200);
    if (error) throw error;
    res.json((data || []).map(e => ({ ...e, to:e.recipient_email, body:e.body_text, order_id:e.related_order_id })));
  } catch (error) { return handleError(res, error); }
});

// Admin Products
app.post('/api/admin/products', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { id, sku, name, brand, category, color, sizes, price, old_price, stock, description, image_url, featured } = req.body;
    if(!name || !category || price === undefined) return res.status(400).json({ error:'Product name, category and price are required' });
    const payload = {
      sku: sku || null,
      name,
      brand: brand || 'AURA',
      category,
      color: color || 'Black',
      sizes: sizes || 'S,M,L,XL',
      price: Number(price),
      old_price: old_price ? Number(old_price) : null,
      stock: Number(stock || 0),
      description: description || '',
      image_url: cleanImageUrl(image_url, name, category, color || 'Black'),
      featured: toBool(featured),
      is_active: true
    };
    if (id) payload.id = Number(id);
    const { data: product, error } = await supabase.from('products').insert(payload).select('*').single();
    if (error) throw error;
    await logAction(req.session.user.id, 'PRODUCT_ADD', `Added product #${product.id}: ${product.name}`, req);
    res.json({ message:'Product added', product });
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/products/:id/stock', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: product } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if(!product) return res.status(404).json({ error:'Product not found' });
    const old = Number(product.stock || 0);
    const newStock = Number(req.body.stock || 0);
    const { error } = await supabase.from('products').update({ stock:newStock }).eq('id', req.params.id);
    if (error) throw error;
    await supabase.from('stock_movements').insert({
      product_id: product.id,
      movement_type: 'manual_adjustment',
      quantity: Math.abs(newStock - old),
      previous_stock: old,
      new_stock: newStock,
      reference_type: 'manual_stock_update',
      note: `Stock changed from ${old} to ${newStock}`,
      created_by: req.session.user.id
    });
    await logAction(req.session.user.id, 'STOCK_UPDATE', `Product #${product.id} (${product.name}) stock changed from ${old} to ${newStock}`, req);
    res.json({ message:'Stock updated' });
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/products/:id', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: old } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    if(!old) return res.status(404).json({ error:'Product not found' });
    const payload = {};
    ['sku','name','brand','category','color','sizes','description'].forEach(k => { if(req.body[k] !== undefined) payload[k] = req.body[k] || null; });
    if(req.body.price !== undefined) payload.price = Number(req.body.price);
    if(req.body.old_price !== undefined) payload.old_price = req.body.old_price === '' ? null : Number(req.body.old_price);
    if(req.body.stock !== undefined) payload.stock = Number(req.body.stock);
    if(req.body.featured !== undefined) payload.featured = toBool(req.body.featured);
    if(req.body.image_url !== undefined) payload.image_url = cleanImageUrl(req.body.image_url, payload.name || old.name, payload.category || old.category, payload.color || old.color);
    const { error } = await supabase.from('products').update(payload).eq('id', req.params.id);
    if (error) throw error;

    const changes=[];
    if(payload.name !== undefined && old.name !== payload.name) changes.push(`name changed from "${old.name}" to "${payload.name}"`);
    if(payload.price !== undefined && Number(old.price) !== Number(payload.price)) changes.push(`price changed from AED ${old.price} to AED ${payload.price}`);
    if(payload.stock !== undefined && Number(old.stock) !== Number(payload.stock)) changes.push(`stock changed from ${old.stock} to ${payload.stock}`);
    if(payload.category !== undefined && old.category !== payload.category) changes.push(`category changed from ${old.category} to ${payload.category}`);
    await logAction(req.session.user.id, 'PRODUCT_UPDATE', `Product #${old.id} (${payload.name || old.name}) updated: ${changes.length ? changes.join('; ') : 'no value changed'}`, req);
    res.json({ message:'Product updated' });
  } catch (error) { return handleError(res, error); }
});

app.delete('/api/admin/products/:id', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: p } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    const { error } = await supabase.from('products').update({ is_active:false }).eq('id', req.params.id);
    if (error) throw error;
    await logAction(req.session.user.id, 'PRODUCT_DELETE', p ? `Deleted product #${p.id} (${p.name})` : `Delete attempted for missing product #${req.params.id}`, req);
    res.json({ message:'Product deleted' });
  } catch (error) { return handleError(res, error); }
});

app.post('/api/admin/products/bulk', requireLogin, requireAdmin, async (req,res) => {
  try {
    const bulk = req.body.products || [];
    const payload = bulk.map(item => ({
      id: item.id ? Number(item.id) : undefined,
      sku: item.sku || null,
      name: item.name,
      brand: item.brand || 'AURA',
      category: item.category,
      color: item.color || 'Black',
      sizes: item.sizes || 'S,M,L,XL',
      price: Number(item.price),
      old_price: item.old_price ? Number(item.old_price) : null,
      stock: Number(item.stock || 0),
      description: item.description || '',
      image_url: cleanImageUrl(item.image_url, item.name, item.category, item.color || 'Black'),
      featured: toBool(item.featured),
      is_active: true
    }));
    const { error } = await supabase.from('products').insert(payload);
    if (error) throw error;
    await logAction(req.session.user.id, 'BULK_UPLOAD', `Bulk uploaded ${bulk.length} products: ${bulk.map(p => (p.id ? '#'+p.id+' ' : '') + p.name).join(', ')}`, req);
    res.json({ message:'Bulk upload successful' });
  } catch (error) { return handleError(res, error); }
});

// Admin Customers, Tickets, Coupons, Logs, Settings
app.get('/api/admin/customers', requireLogin, requireAdmin, async (req,res) => {
  try {
    const [{ data: customers }, { data: orders }] = await Promise.all([
      supabase.from('users').select('*').eq('role', 'customer').order('created_at', { ascending:false }),
      supabase.from('orders').select('*')
    ]);
    res.json((customers || []).map(u => ({
      ...u,
      order_count:(orders || []).filter(o=>Number(o.user_id)===Number(u.id)).length,
      total_spend:(orders || []).filter(o=>Number(o.user_id)===Number(u.id)).reduce((s,o)=>s+Number(o.total_amount || 0),0)
    })));
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/tickets', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data, error } = await supabase.from('support_tickets').select('*, user:users(name,email)').order('created_at', { ascending:false });
    if (error) throw error;
    res.json((data || []).map(t => ({ ...t, user_name:t.user?.name, user_email:t.user?.email })));
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/tickets/:id', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: old } = await supabase.from('support_tickets').select('*').eq('id', req.params.id).single();
    if(!old) return res.status(404).json({ error:'Ticket not found' });
    const payload = {};
    if (req.body.status) payload.status = req.body.status;
    if (req.body.admin_reply !== undefined) payload.admin_reply = req.body.admin_reply;
    const { error } = await supabase.from('support_tickets').update(payload).eq('id', req.params.id);
    if (error) throw error;
    await logAction(req.session.user.id, 'TICKET_UPDATE', `Ticket #${old.id} status changed from ${old.status} to ${payload.status || old.status}`, req);
    res.json({ message:'Ticket updated' });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/coupons', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending:false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) { return handleError(res, error); }
});

app.post('/api/admin/coupons', requireLogin, requireAdmin, async (req,res) => {
  try {
    const code = String(req.body.code || '').toUpperCase().trim();
    if(!code) return res.status(400).json({ error:'Coupon code required' });
    const { data: coupon, error } = await supabase.from('coupons').insert({
      code,
      type: req.body.type || 'percentage',
      value: Number(req.body.value || 0),
      status: req.body.status || 'active'
    }).select('*').single();
    if (error) throw error;
    await logAction(req.session.user.id, 'COUPON_ADD', `Added coupon ${coupon.code} (${coupon.type} ${coupon.value})`, req);
    res.json(coupon);
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/coupons/:id', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data: old } = await supabase.from('coupons').select('*').eq('id', req.params.id).single();
    if(!old) return res.status(404).json({ error:'Coupon not found' });
    const { data: coupon, error } = await supabase.from('coupons').update({ status:req.body.status || old.status }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await logAction(req.session.user.id, 'COUPON_UPDATE', `Coupon ${old.code} status changed from ${old.status} to ${coupon.status}`, req);
    res.json(coupon);
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/logs', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data, error } = await supabase.from('activity_logs').select('*').order('created_at', { ascending:false }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (error) { return handleError(res, error); }
});

app.get('/api/admin/settings', requireLogin, requireAdmin, async (req,res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    const settings = {};
    (data || []).forEach(row => { settings[row.setting_key] = row.setting_value; });
    res.json(settings);
  } catch (error) { return handleError(res, error); }
});

app.put('/api/admin/settings', requireLogin, requireAdmin, async (req,res) => {
  try {
    const entries = Object.entries(req.body || {});
    for (const [setting_key, setting_value] of entries) {
      const { error } = await supabase.from('settings').upsert({ setting_key, setting_value:String(setting_value ?? '') }, { onConflict:'setting_key' });
      if (error) throw error;
    }
    await logAction(req.session.user.id, 'SETTINGS_UPDATE', 'Store settings updated', req);
    const { data } = await supabase.from('settings').select('*');
    const settings = {};
    (data || []).forEach(row => { settings[row.setting_key] = row.setting_value; });
    res.json(settings);
  } catch (error) { return handleError(res, error); }
});

app.get('/success', (req,res)=>res.sendFile(path.join(__dirname,'public/success.html')));
app.get('/cancel', (req,res)=>res.sendFile(path.join(__dirname,'public/cancel.html')));
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public/admin.html')));
app.get('/admin.html', (req,res)=>res.sendFile(path.join(__dirname,'public/admin.html')));
app.use((req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));

app.listen(PORT, () => console.log(`AURA ecommerce running on http://localhost:${PORT}`));
