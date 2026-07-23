const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

require('dotenv').config();

const app = express();
const pool = require('./db'); // Pool de conexión a Postgres

app.use(express.json());

const origenesPermitidos = [
  'http://localhost:5173',
  'https://animated-platypus-df4a3d.netlify.app',
  'https://delightful-rugelach-42e0e1.netlify.app'
];

const corsOptions = {
  origin(origin, callback) {
    // Si no hay origin (p. ej. herramientas o Server-to-Server)
    if (!origin) {
      return callback(null, true);
    }

    // Limpiamos barras al final si las hubiera
    const originLimpio = origin.replace(/\/$/, "");

    // Verificamos si está en la lista permitida o si pertenece a netlify.app
    const esPermitido = origenesPermitidos.includes(originLimpio) || originLimpio.endsWith('.netlify.app');

    if (esPermitido) {
      callback(null, true);
    } else {
      console.warn(`⚠️ Intento de acceso bloqueado por CORS desde el origen: ${origin}`);
      callback(new Error(`No permitido por CORS (Origen: ${origin})`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));

// Almacenamiento temporal en memoria para las sesiones activas
const sesionesActivas = {};
const DURACION_SESION_MS = 2 * 60 * 60 * 1000; 

const CATALOGO_BEBIDAS = {
    'Fernet': 10000,
    'Cerveza': 5000,
    'Vodka': 8000,
    'Agua': 4000,
    'Jarra Gaseosa': 4000,
    'Lata Energizante': 4000
};

const INSUMOS = {
    'Fernet': { tipo: 'botella' },
    'Vodka': { tipo: 'botella' },
    'Coca-Cola': { tipo: 'botella' },
    'Sprite': { tipo: 'botella' },
    'Cerveza': { tipo: 'unidad' },
    'Agua': { tipo: 'unidad' },
    'Lata Energizante': { tipo: 'unidad' }
};

const RECETAS = {
    'Fernet': [
        { insumo: 'Fernet', fraccion: 1 / 7 },
        { insumo: 'Coca-Cola', fraccion: 1 / 3 }
    ],
    'Vodka': [
        { insumo: 'Vodka', fraccion: 1 / 7 },
        { insumo: 'Sprite', fraccion: 1 / 3 }
    ],
    'Cerveza': [{ insumo: 'Cerveza', fraccion: 1 }],
    'Agua': [{ insumo: 'Agua', fraccion: 1 }],
    'Lata Energizante': [{ insumo: 'Lata Energizante', fraccion: 1 }],
};

function calcularConsumoInsumos(venta) {
    const { producto, cantidad, sabor } = venta;

    if (producto === 'Jarra Gaseosa') {
        if (!sabor || (sabor !== 'Coca-Cola' && sabor !== 'Sprite')) return [];
        return [{ insumo: sabor, cantidad: cantidad * 0.5 }];
    }

    const receta = RECETAS[producto];
    if (!receta) return [];

    return receta.map(({ insumo, fraccion }) => ({
        insumo,
        cantidad: cantidad * fraccion
    }));
}


const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4, // 👈 FUERZA EL USO DE IPv4 (Soluciona ENETUNREACH en Render)
  auth: {
    user: process.env.GMAILAPI,
    pass: process.env.PASSAPI
  },
  tls: {
    rejectUnauthorized: false
  }
});

const LOGO_PATH = path.join(__dirname, 'assets', 'BACO-Produ-Blanco.png');
const LOGO_CID = 'logoBacoProducciones';

function adjuntosLogo() {
    return [
        {
            filename: 'baco-logo.png',
            path: LOGO_PATH,
            cid: LOGO_CID
        }
    ];
}

function plantillaEmail(contenidoHtml) {
    return `
    <div style="background-color:#000000; padding:32px 16px; font-family: Arial, sans-serif;">
        <div style="max-width:500px; margin:0 auto; background-color:#000000; border-radius:12px; border:1px solid #1f2937; overflow:hidden;">
            <div style="background-color:#000000; padding:24px; text-align:center; border-bottom:1px solid #1f2937;">
                <img src="cid:${LOGO_CID}" alt="Baco Producciones" style="max-width:170px; width:100%; height:auto; display:inline-block;" />
            </div>
            <div style="padding:30px; text-align:center; color:#ffffff;">
                ${contenidoHtml}
            </div>
        </div>
    </div>
    `;
}

function filaATicket(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        email: row.email,
        tipoTicket: row.tipo_ticket,
        tanda: row.tanda,
        cantidadPersonas: row.cantidad_personas,
        precio: Number(row.precio),
        asistio: row.asistio,
        vendedorId: row.vendedor_id,
        fechaRegistro: row.fecha_registro
    };
}

function filaAVale(row) {
    return {
        id: row.id,
        codigo: row.codigo,
        rrppId: row.rrpp_id,
        rrppNombre: row.rrpp_nombre,
        premio: row.premio,
        fechaEntrega: row.fecha_entrega,
        estado: row.estado,
        fechaCanje: row.fecha_canje,
        atendidoPor: row.atendido_por
    };
}

function filaAGasto(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        descripcion: row.descripcion,
        precio: Number(row.precio),
        registradoPor: row.registrado_por,
        fechaRegistro: row.fecha_registro
    };
}

function filaATandas(row) {
    return {
        primera: Number(row.primera),
        segunda: Number(row.segunda),
        tercera: Number(row.tercera),
        tandaActiva: row.tanda_activa
    };
}

async function obtenerTandas() {
    const { rows } = await pool.query('SELECT * FROM tandas WHERE id = 1');
    if (rows.length === 0) {
        await pool.query(
            `INSERT INTO tandas (id, primera, segunda, tercera, tanda_activa)
             VALUES (1, 5000, 7000, 10000, 'primera')`
        );
        return { primera: 5000, segunda: 7000, tercera: 10000, tandaActiva: 'primera' };
    }
    return filaATandas(rows[0]);
}

function verificarSesion(rolesPermitidos = []) {
    return (req, res, next) => {
        const token = req.headers['authorization'];

        if (!token || !sesionesActivas[token]) {
            return res.status(401).json({ error: 'Sesión no iniciada o inválida' });
        }

        const sesion = sesionesActivas[token];

        if (new Date() > sesion.expira) {
            delete sesionesActivas[token];
            return res.status(401).json({ error: 'La sesión ha expirado. Por favor, iniciá sesión nuevamente.' });
        }

        if (sesion.rol === 'admin') {
            sesion.expira = new Date(Date.now() + DURACION_SESION_MS);
            req.usuarioSesion = sesion;
            return next();
        }

        if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(sesion.rol)) {
            return res.status(403).json({ error: 'No tenés permisos para realizar esta acción' });
        }

        sesion.expira = new Date(Date.now() + DURACION_SESION_MS);
        req.usuarioSesion = sesion; 
        next();
    };
}

// ==================== RUTAS ====================

app.post('/api/auth/registrar-personal', async (req, res, next) => {
    try {
        const { nombre, usuario, password, rol, email } = req.body;

        if (!nombre || !usuario || !password || !rol || !email) {
            return res.status(400).json({ error: 'Faltan campos requeridos (Nombre, Usuario, Password, Rol y Email)' });
        }

        if (!['rrpp', 'barra', 'control', 'admin'].includes(rol)) {
            return res.status(400).json({ error: 'Rol inválido. Debe ser: rrpp, barra, control o admin' });
        }

        const { rows: usuarioExistente } = await pool.query(
            'SELECT id FROM personal WHERE LOWER(usuario) = LOWER($1)',
            [usuario]
        );
        if (usuarioExistente.length > 0) {
            return res.status(400).json({ error: 'El nombre de usuario ya está registrado' });
        }

        const { rows: emailExistente } = await pool.query(
            'SELECT id FROM personal WHERE LOWER(email) = LOWER($1)',
            [email]
        );
        if (emailExistente.length > 0) {
            return res.status(400).json({ error: 'El correo electrónico ya está registrado por otro usuario' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordEncriptada = await bcrypt.hash(password, salt);
        const id = uuidv4().split('-')[0];

        await pool.query(
            `INSERT INTO personal (id, nombre, usuario, password, rol, email, historias)
             VALUES ($1, $2, $3, $4, $5, $6, 0)`,
            [id, nombre, usuario, passwordEncriptada, rol, email.trim()]
        );

        res.status(201).json({ mensaje: 'Usuario registrado con éxito', rol });
    } catch (error) {
        next(error);
    }
});

app.post('/test', (req, res) => {
    res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const { usuario, password } = req.body;

        const { rows } = await pool.query('SELECT * FROM personal WHERE usuario = $1', [usuario]);
        const usuarioEncontrado = rows[0];

        if (!usuarioEncontrado) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const passwordCorrecta = await bcrypt.compare(password, usuarioEncontrado.password);

        if (!passwordCorrecta) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const token = uuidv4();

        sesionesActivas[token] = {
            usuarioId: usuarioEncontrado.id,
            nombre: usuarioEncontrado.nombre,
            rol: usuarioEncontrado.rol,
            expira: new Date(Date.now() + DURACION_SESION_MS)
        };

        res.json({
            mensaje: 'Login exitoso',
            token,
            rol: usuarioEncontrado.rol,
            nombre: usuarioEncontrado.nombre
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/tandas', verificarSesion(['rrpp', 'barra', 'control']), async (req, res, next) => {
    try {
        const tandas = await obtenerTandas();
        res.json(tandas);
    } catch (error) {
        next(error);
    }
});

app.patch('/api/admin/tandas', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { primera, segunda, tercera, tandaActiva } = req.body;
        const actuales = await obtenerTandas();

        let nuevaPrimera = actuales.primera;
        let nuevaSegunda = actuales.segunda;
        let nuevaTercera = actuales.tercera;
        let nuevaTandaActiva = actuales.tandaActiva;

        if (primera !== undefined) {
            const p = parseFloat(primera);
            if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de primera tanda inválido' });
            nuevaPrimera = p;
        }
        if (segunda !== undefined) {
            const p = parseFloat(segunda);
            if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de segunda tanda inválido' });
            nuevaSegunda = p;
        }
        if (tercera !== undefined) {
            const p = parseFloat(tercera);
            if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de tercera tanda inválido' });
            nuevaTercera = p;
        }
        if (tandaActiva !== undefined) {
            if (!['primera', 'segunda', 'tercera'].includes(tandaActiva)) {
                return res.status(400).json({ error: 'tandaActiva debe ser: primera, segunda o tercera' });
            }
            nuevaTandaActiva = tandaActiva;
        }

        await pool.query(
            'UPDATE tandas SET primera = $1, segunda = $2, tercera = $3, tanda_activa = $4 WHERE id = 1',
            [nuevaPrimera, nuevaSegunda, nuevaTercera, nuevaTandaActiva]
        );

        const tandas = await obtenerTandas();
        res.json({ mensaje: 'Tandas actualizadas correctamente', tandas });
    } catch (error) {
        next(error);
    }
});

async function crearTicketYEnviarMail({ nombre, email, tipoTicket, tanda, cantidadPersonas, precio, vendedorId }, res) {
    const id = uuidv4().split('-')[0];
    const fechaRegistro = new Date().toISOString();

    const urlValidacion = `http://localhost:5173/validar/${id}`;
    const qrImagenUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(urlValidacion)}`;

    let etiquetaTipo = `Entrada General · Tanda ${tanda}`;
    if (tipoTicket === 'cumpleanos') {
        etiquetaTipo = `🎂 Lista de Cumpleaños · ${cantidadPersonas} persona${cantidadPersonas > 1 ? 's' : ''} en total`;
    } else if (tipoTicket === '2x1') {
        etiquetaTipo = `🎉 2x1 · Tanda ${tanda} · ingresan 2 personas`;
    }

    const contenidoHtml = `
        <h2 style="color: #818cf8; font-size: 24px; margin-bottom: 10px;">¡Hola, ${nombre}!</h2>
        <p style="color: #9ca3af; font-size: 16px;">Tu entrada para el evento se procesó con éxito.</p>
        <p style="color: #a5b4fc; font-size: 14px; font-weight: bold; margin-bottom: 5px;">${etiquetaTipo}</p>
        <p style="color: #9ca3af; font-size: 14px; margin-bottom: 25px;">Presentá este código QR en tu celular al ingresar a la puerta.</p>

        <div style="background-color: #ffffff; padding: 15px; display: inline-block; border-radius: 8px; margin-bottom: 25px;">
            <img src="${qrImagenUrl}" alt="Código QR de Acceso" style="display: block; width: 250px; height: 250px;" />
        </div>

        <p style="font-size: 12px; color: #4b5563; margin-top: 15px; font-family: monospace;">ID único de ticket: ${id}</p>
    `;

    const mailOptions = {
        from: '"Control de Accesos Baco" <baco.producciones26@gmail.com>',
        to: email,
        subject: `¡Tu entrada para el Evento está lista! 🎟️ - ${nombre}`,
        html: plantillaEmail(contenidoHtml),
        attachments: adjuntosLogo()
    };

    try {
        await transporter.sendMail(mailOptions);

        await pool.query(
            `INSERT INTO compradores (id, nombre, email, tipo_ticket, tanda, cantidad_personas, precio, asistio, vendedor_id, fecha_registro)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
            [id, nombre, email, tipoTicket, tanda, cantidadPersonas, precio, vendedorId, fechaRegistro]
        );

        res.status(201).json({
            mensaje: `¡Registro exitoso! La entrada con el QR fue enviada a: ${email}`,
            ticket: { id, nombre, email, tipoTicket, tanda, cantidadPersonas, precio, asistio: false, vendedorId, fechaRegistro }
        });
    } catch (error) {
        console.error("Error en Nodemailer:", error);
        res.status(500).json({ error: 'No se pudo enviar el correo electrónico con el QR.' });
    }
}

app.post('/api/registrar', verificarSesion(['rrpp']), async (req, res, next) => {
    try {
        const { nombre, email } = req.body;

        if (!nombre || !email) {
            return res.status(400).json({ error: 'Faltan datos requeridos (nombre y email)' });
        }

        const tandas = await obtenerTandas();
        const tandaActiva = tandas.tandaActiva;
        const precio = tandas[tandaActiva];

        await crearTicketYEnviarMail({
            nombre,
            email,
            tipoTicket: 'general',
            tanda: tandaActiva,
            cantidadPersonas: 1,
            precio,
            vendedorId: req.usuarioSesion.usuarioId
        }, res);
    } catch (error) {
        next(error);
    }
});

app.post('/api/admin/registrar-especial', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { nombre, email, tipoTicket, tanda, cantidadPersonas } = req.body;

        if (!nombre || !email) {
            return res.status(400).json({ error: 'Faltan datos requeridos (nombre y email)' });
        }

        if (!['cumpleanos', '2x1'].includes(tipoTicket)) {
            return res.status(400).json({ error: 'tipoTicket inválido. Debe ser: cumpleanos o 2x1' });
        }

        let precioFinal = 0;
        let tandaFinal = null;
        let personas = 1;

        if (tipoTicket === 'cumpleanos') {
            const acompanantes = parseInt(cantidadPersonas);
            if (!Number.isInteger(acompanantes) || acompanantes < 0) {
                return res.status(400).json({ error: 'Para la lista de cumpleaños hay que indicar cantidadPersonas como un número válido (0 o más)' });
            }
            precioFinal = 0;
            personas = acompanantes + 1;

        } else if (tipoTicket === '2x1') {
            const tandas = await obtenerTandas();
            const tandaElegida = tanda || tandas.tandaActiva;

            if (!['primera', 'segunda', 'tercera'].includes(tandaElegida)) {
                return res.status(400).json({ error: 'tanda inválida. Debe ser: primera, segunda o tercera' });
            }

            precioFinal = tandas[tandaElegida];
            tandaFinal = tandaElegida;
            personas = 2;
        }

        await crearTicketYEnviarMail({
            nombre,
            email,
            tipoTicket,
            tanda: tandaFinal,
            cantidadPersonas: personas,
            precio: precioFinal,
            vendedorId: 'ADMIN-ESPECIAL'
        }, res);
    } catch (error) {
        next(error);
    }
});

app.get('/api/bebidas/catalogo', verificarSesion(['barra']), (req, res) => {
    res.json(CATALOGO_BEBIDAS);
});

app.post('/api/bebidas/anotar', verificarSesion(['barra']), async (req, res, next) => {
    try {
        const { producto, cantidad, sabor, conDescuento } = req.body;

        if (!producto || !cantidad) {
            return res.status(400).json({ error: 'Faltan datos de la venta' });
        }

        const precioBase = CATALOGO_BEBIDAS[producto];
        if (precioBase === undefined) {
            return res.status(400).json({ error: 'Producto no reconocido' });
        }

        const cantidadNum = parseInt(cantidad);
        if (!Number.isInteger(cantidadNum) || cantidadNum <= 0) {
            return res.status(400).json({ error: 'Cantidad inválida' });
        }

        if (producto === 'Jarra Gaseosa' && sabor !== 'Coca-Cola' && sabor !== 'Sprite') {
            return res.status(400).json({ error: 'Para la Jarra Gaseosa hay que indicar el sabor: "Coca-Cola" o "Sprite".' });
        }

        const descuentoAplicado = conDescuento === true;
        const precioUnitario = descuentoAplicado
            ? Math.round(precioBase * 0.8)
            : precioBase;

        const id = uuidv4().split('-')[0];
        const precioTotal = precioUnitario * cantidadNum;
        const saborFinal = producto === 'Jarra Gaseosa' ? sabor : null;
        const fechaVenta = new Date().toISOString();

        await pool.query(
            `INSERT INTO bebida (id, producto, cantidad, sabor, precio_unitario, precio_total, con_descuento, encargado_id, fecha_venta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, producto, cantidadNum, saborFinal, precioUnitario, precioTotal, descuentoAplicado, req.usuarioSesion.usuarioId, fechaVenta]
        );

        const nuevaVenta = {
            id,
            producto,
            cantidad: cantidadNum,
            ...(saborFinal ? { sabor: saborFinal } : {}),
            precioUnitario,
            precioTotal,
            conDescuento: descuentoAplicado,
            encargadoId: req.usuarioSesion.usuarioId,
            fechaVenta
        };

        res.status(201).json({ mensaje: 'Bebida anotada correctamente', venta: nuevaVenta });
    } catch (error) {
        next(error);
    }
});

app.patch('/api/validar/:id', verificarSesion(['rrpp', 'control']), async (req, res, next) => {
    try {
        const { id } = req.params;

        const { rows } = await pool.query('SELECT * FROM compradores WHERE id = $1', [id]);
        const comprador = rows[0];

        if (!comprador) {
            return res.status(404).json({ estado: 'INVALIDO', mensaje: 'El ticket no pertenece a la lista o es inválido.' });
        }

        if (comprador.asistio) {
            return res.status(200).json({ 
                estado: 'REPETIDO', 
                mensaje: `¡ALERTA! Este ticket ya ingresó. Pertenece a ${comprador.nombre}`,
                cantidadPersonas: comprador.cantidad_personas || 1,
                tipoTicket: comprador.tipo_ticket || 'general'
            });
        }

        await pool.query('UPDATE compradores SET asistio = true WHERE id = $1', [id]);

        let mensajeExtra = '';
        if (comprador.tipo_ticket === 'cumpleanos') {
            mensajeExtra = ` — 🎂 Cumpleaños: ingresan ${comprador.cantidad_personas} persona(s) en total.`;
        } else if (comprador.tipo_ticket === '2x1') {
            mensajeExtra = ' — 🎉 2x1: ingresan 2 personas con este QR.';
        }

        res.status(200).json({ 
            estado: 'VALIDO', 
            mensaje: `¡Acceso concedido! Bienvenido/a, ${comprador.nombre}.${mensajeExtra}`,
            cantidadPersonas: comprador.cantidad_personas || 1,
            tipoTicket: comprador.tipo_ticket || 'general',
            tanda: comprador.tanda || null
        });
    } catch (error) {
        next(error);
    }
});

app.patch('/api/bebidas/canjear-vale/:codigo', verificarSesion(['barra']), async (req, res, next) => {
    try {
        const { codigo } = req.params;

        const { rows } = await pool.query(
            'SELECT * FROM vales_otorgados WHERE LOWER(codigo) = LOWER($1)',
            [codigo]
        );
        const vale = rows[0];

        if (!vale) {
            return res.status(404).json({ error: 'El código de vale es inválido o no existe.' });
        }

        if (vale.estado === 'CANJEADO') {
            return res.status(400).json({ error: `¡ERROR! Este vale ya fue canjeado el ${new Date(vale.fecha_canje).toLocaleString('es-AR')}.` });
        }

        await pool.query(
            'UPDATE vales_otorgados SET estado = $1, fecha_canje = now(), atendido_por = $2 WHERE id = $3',
            ['CANJEADO', req.usuarioSesion.usuarioId, vale.id]
        );

        res.json({ mensaje: `¡Vale verificado con éxito! Otorga: ${vale.premio} a ${vale.rrpp_nombre}` });
    } catch (error) {
        next(error);
    }
});

// ==================== RUTAS ADMIN ====================

app.get('/api/admin/total-bebidas', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            'SELECT COALESCE(SUM(cantidad), 0) AS total, COALESCE(SUM(precio_total), 0) AS monto_total FROM bebida'
        );
        res.json({ total: Number(rows[0].total), montoTotal: Number(rows[0].monto_total) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/total-entradas', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM compradores');
        const compradores = rows.map(filaATicket);

        const resumenPorTipo = {
            general: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
            '2x1': { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
            cumpleanos: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
            regalo: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 }
        };

        const resumenPorTanda = {
            primera: { cantidadTickets: 0, monto: 0 },
            segunda: { cantidadTickets: 0, monto: 0 },
            tercera: { cantidadTickets: 0, monto: 0 }
        };

        let montoTotal = 0;
        let personasVendidasTotal = 0;
        let personasIngresadasTotal = 0;

        compradores.forEach(c => {
            const tipo = c.tipoTicket || 'general';
            const personas = c.cantidadPersonas || 1;
            const precio = c.precio || 0;

            if (resumenPorTipo[tipo]) {
                resumenPorTipo[tipo].cantidadTickets += 1;
                resumenPorTipo[tipo].personasTotales += personas;
                resumenPorTipo[tipo].monto += precio;
                if (c.asistio) {
                    resumenPorTipo[tipo].personasIngresadas += personas;
                }
            }

            if (c.tanda && resumenPorTanda[c.tanda]) {
                resumenPorTanda[c.tanda].cantidadTickets += 1;
                resumenPorTanda[c.tanda].monto += precio;
            }

            montoTotal += precio;
            personasVendidasTotal += personas;
            if (c.asistio) {
                personasIngresadasTotal += personas;
            }
        });

        res.json({
            montoTotal,
            personasVendidasTotal,
            personasIngresadasTotal,
            porTipo: resumenPorTipo,
            porTanda: resumenPorTanda
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/listado-rrpp', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows: usuariosRows } = await pool.query("SELECT * FROM personal WHERE rol = 'rrpp'");
        const { rows: compradoresRows } = await pool.query('SELECT * FROM compradores');
        const compradores = compradoresRows.map(filaATicket);

        const listaRrpp = usuariosRows.map(u => {
            const entradasDelVendedor = compradores.filter(c => c.vendedorId === u.id);
            const entradasVendidas = entradasDelVendedor.length;
            const personasVendidas = entradasDelVendedor.reduce((acc, c) => acc + (c.cantidadPersonas || 1), 0);
            const montoGenerado = entradasDelVendedor.reduce((acc, c) => acc + (c.precio || 0), 0);

            return {
                _id: u.id,
                nombre: u.nombre,
                usuario: u.usuario,
                historias: u.historias || 0,
                entradasVendidas,
                personasVendidas,
                montoGenerado
            };
        });
        res.json(listaRrpp);
    } catch (error) {
        next(error);
    }
});

app.patch('/api/admin/rrpp/:id/historias', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { cambio } = req.body;

        if (cambio !== 1 && cambio !== -1) {
            return res.status(400).json({ error: 'Cambio inválido.' });
        }

        const { rows } = await pool.query("SELECT historias FROM personal WHERE id = $1 AND rol = 'rrpp'", [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'RRPP no encontrado' });
        }

        const nuevoValor = Math.max(0, (rows[0].historias || 0) + cambio);
        await pool.query('UPDATE personal SET historias = $1 WHERE id = $2', [nuevoValor, id]);

        res.json({ mensaje: 'Historias actualizadas', historias: nuevoValor });
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/vales-historial', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM vales_otorgados ORDER BY fecha_entrega DESC');
        res.json(rows.map(filaAVale));
    } catch (error) {
        next(error);
    }
});

app.get('/api/admin/stock-insumos', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows: stockRows } = await pool.query('SELECT * FROM stock_insumos');
        const { rows: ventasRows } = await pool.query('SELECT producto, cantidad, sabor FROM bebida');

        const consumoPorInsumo = {};
        ventasRows.forEach(venta => {
            const consumos = calcularConsumoInsumos(venta);
            consumos.forEach(({ insumo, cantidad }) => {
                consumoPorInsumo[insumo] = (consumoPorInsumo[insumo] || 0) + cantidad;
            });
        });

        const listaStock = Object.keys(INSUMOS).map(insumo => {
            const stockItem = stockRows.find(s => s.insumo === insumo);
            const stockActual = stockItem ? Number(stockItem.cantidad) : 0;
            const consumido = consumoPorInsumo[insumo] || 0;
            const restante = Math.max(0, stockActual - consumido);

            return {
                insumo,
                tipo: INSUMOS[insumo].tipo,
                stockActual: Math.round(stockActual * 100) / 100,
                consumido: Math.round(consumido * 100) / 100,
                restante: Math.round(restante * 100) / 100
            };
        });

        res.json(listaStock);
    } catch (error) {
        next(error);
    }
});

app.patch('/api/admin/stock-insumos/:insumo', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { insumo } = req.params;
        const { cantidad } = req.body;

        if (!INSUMOS[insumo]) {
            return res.status(400).json({ error: 'Insumo no reconocido.' });
        }

        const cantidadNum = parseFloat(cantidad);
        if (isNaN(cantidadNum) || cantidadNum < 0) {
            return res.status(400).json({ error: 'La cantidad debe ser un número mayor o igual a 0.' });
        }

        await pool.query(
            `INSERT INTO stock_insumos (insumo, cantidad) VALUES ($1, $2)
             ON CONFLICT (insumo) DO UPDATE SET cantidad = EXCLUDED.cantidad`,
            [insumo, cantidadNum]
        );

        res.json({ mensaje: `Stock de ${insumo} actualizado a ${cantidadNum} ${INSUMOS[insumo].tipo}(s).`, stockActual: cantidadNum });
    } catch (error) {
        next(error);
    }
});

app.post('/api/admin/otorgar-vale', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rrppId, tipoPremio, premioDetalle } = req.body; 

        if (!rrppId || !tipoPremio || !premioDetalle) {
            return res.status(400).json({ error: 'Faltan parámetros: rrppId, tipoPremio o premioDetalle.' });
        }

        const { rows } = await pool.query("SELECT * FROM personal WHERE id = $1 AND rol = 'rrpp'", [rrppId]);
        const rrpp = rows[0];

        if (!rrpp) {
            return res.status(404).json({ error: 'No se encontró al RRPP especificado.' });
        }

        const correoDestinatario = rrpp.email;

        if (tipoPremio === 'entrada') {
            const ticketId = uuidv4().split('-')[0];

            const urlValidacion = `http://localhost:5173/validar/${ticketId}`;
            const qrImagenUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(urlValidacion)}`;

            const contenidoHtml = `
                <h2 style="color: #a855f7; font-size: 24px; margin-bottom: 10px;">¡Premio para ${rrpp.nombre}! 🎟️</h2>
                <p style="color: #9ca3af; font-size: 15px;">Te otorgamos una entrada free en reconocimiento por tu laburo: <strong>${premioDetalle}</strong></p>
                <p style="color: #9ca3af; font-size: 13px; margin-bottom: 25px;">Presentá este código QR directamente al personal de Control en la puerta.</p>
                <div style="background-color: #ffffff; padding: 15px; display: inline-block; border-radius: 8px; margin-bottom: 25px;">
                    <img src="${qrImagenUrl}" alt="QR Entrada Regalada" style="display: block; width: 250px; height: 250px;" />
                </div>
                <p style="font-size: 11px; color: #4b5563; font-family: monospace;">ID de Entrada: ${ticketId}</p>
            `;

            const mailOptions = {
                from: '"Administración Baco" <baco.producciones26@gmail.com>',
                to: correoDestinatario,
                subject: `🎁 ¡Acá tenés tu Entrada de Regalo! - ${rrpp.nombre}`,
                html: plantillaEmail(contenidoHtml),
                attachments: adjuntosLogo()
            };

            await pool.query(
                `INSERT INTO compradores (id, nombre, email, tipo_ticket, tanda, cantidad_personas, precio, asistio, vendedor_id)
                 VALUES ($1, $2, $3, 'regalo', NULL, 1, 0, false, 'ADMIN-PREMIO')`,
                [ticketId, `${rrpp.nombre} (Premio Staff)`, correoDestinatario]
            );

            try {
                await transporter.sendMail(mailOptions);
                return res.status(201).json({ mensaje: `¡Premio emitido! Entrada free enviada con éxito a ${correoDestinatario}.` });
            } catch (error) {
                console.error("⚠️ Error Nodemailer (Entrada):", error.message);
                return res.status(201).json({ mensaje: `⚠️ Registrado en base de datos, pero falló el envío del mail. ID del ticket: ${ticketId}` });
            }

        } else if (tipoPremio === 'bebida') {
            const idVale = uuidv4().split('-')[0];
            const codigoVale = `BACO-${uuidv4().split('-')[0].toUpperCase()}`;

            const contenidoHtml = `
                <h2 style="color: #38bdf8; font-size: 24px; margin-bottom: 5px;">¡Vale de Consumición! 🎉</h2>
                <p style="color: #94a3b8; font-size: 15px; margin-bottom: 20px;">Ganaste un beneficio para retirar en barra: </p>
                <div style="background-color: #1e293b; padding: 20px; border-radius: 8px; border: 1px dashed #38bdf8; margin-bottom: 20px;">
                    <strong style="font-size: 20px; color: #f43f5e; display: block; margin-bottom: 15px;">${premioDetalle}</strong>
                    <span style="font-family: monospace; font-size: 22px; font-weight: bold; color: #38bdf8; background-color: #0f172a; padding: 6px 15px; border-radius: 4px; display: inline-block; letter-spacing: 2px;">
                        ${codigoVale}
                    </span>
                </div>
                <p style="font-size: 13px; color: #64748b;">Mostrá este código único en la Barra. Solo sirve para un (1) uso único.</p>
            `;

            const mailOptions = {
                from: '"Premios Barra Baco" <baco.producciones26@gmail.com>',
                to: correoDestinatario,
                subject: `🎁 ¡Tenés un Vale de Barra Libre! - ${rrpp.nombre}`,
                html: plantillaEmail(contenidoHtml),
                attachments: adjuntosLogo()
            };

            await pool.query(
                `INSERT INTO vales_otorgados (id, codigo, rrpp_id, rrpp_nombre, premio, estado)
                 VALUES ($1, $2, $3, $4, $5, 'PENDIENTE')`,
                [idVale, codigoVale, rrpp.id, rrpp.nombre, premioDetalle]
            );

            try {
                await transporter.sendMail(mailOptions);
                return res.status(201).json({ mensaje: `¡Premio emitido! Vale [ ${codigoVale} ] enviado a ${correoDestinatario}.` });
            } catch (error) {
                console.error("⚠️ Error Nodemailer (Bebida):", error.message);
                return res.status(201).json({ mensaje: `⚠️ Registrado en sistema (Fallo de Red/Mail). Copiá este código para el RRPP: [ ${codigoVale} ]` });
            }
        } else {
            return res.status(400).json({ error: 'Tipo de premio no soportado.' });
        }
    } catch (error) {
        next(error);
    }
});

// ==================== GASTOS ====================

app.get('/api/admin/gastos', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM gastos ORDER BY fecha_registro DESC');
        const gastos = rows.map(filaAGasto);
        const totalGastos = gastos.reduce((acumulador, gasto) => acumulador + (gasto.precio || 0), 0);

        res.json({ gastos, totalGastos });
    } catch (error) {
        next(error);
    }
});

app.post('/api/admin/gastos', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { nombre, descripcion, precio } = req.body;

        if (!nombre || !descripcion) {
            return res.status(400).json({ error: 'Faltan datos: nombre y descripción son obligatorios.' });
        }

        const precioNum = parseFloat(precio);
        if (isNaN(precioNum) || precioNum < 0) {
            return res.status(400).json({ error: 'El precio debe ser un número mayor o igual a 0.' });
        }

        const id = uuidv4().split('-')[0];
        const fechaRegistro = new Date().toISOString();

        await pool.query(
            `INSERT INTO gastos (id, nombre, descripcion, precio, registrado_por, fecha_registro)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, nombre, descripcion, precioNum, req.usuarioSesion.usuarioId, fechaRegistro]
        );

        const { rows } = await pool.query('SELECT COALESCE(SUM(precio), 0) AS total FROM gastos');

        const nuevoGasto = {
            id,
            nombre,
            descripcion,
            precio: precioNum,
            registradoPor: req.usuarioSesion.usuarioId,
            fechaRegistro
        };

        res.status(201).json({ mensaje: 'Gasto registrado correctamente', gasto: nuevoGasto, totalGastos: Number(rows[0].total) });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/admin/gastos/:id', verificarSesion(['admin']), async (req, res, next) => {
    try {
        const { id } = req.params;

        const resultado = await pool.query('DELETE FROM gastos WHERE id = $1', [id]);
        if (resultado.rowCount === 0) {
            return res.status(404).json({ error: 'Gasto no encontrado.' });
        }

        const { rows } = await pool.query('SELECT COALESCE(SUM(precio), 0) AS total FROM gastos');

        res.json({ mensaje: 'Gasto eliminado correctamente', totalGastos: Number(rows[0].total) });
    } catch (error) {
        next(error);
    }
});

// ==================== MANEJO GLOBAL DE ERRORES ====================

app.use((err, req, res, next) => {
    console.error("ERROR GLOBAL:", err);
    res.status(500).json({
        error: err.message || 'Error interno del servidor'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor de BacoTickets corriendo en puerto: ${PORT}`);
});